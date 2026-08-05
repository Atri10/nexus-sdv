import { beforeEach, describe, it, expect, jest, mock } from 'bun:test';
import { Readable } from 'stream';
import { getDeviceTimeSeries, DEFAULT_PAGE_SIZE } from '@/lib/device-detail';
import { getTelemetryTable } from '@/lib/bigtable';

mock.module('@/lib/bigtable', () => ({ getTelemetryTable: jest.fn() }));

// getDeviceTimeSeries reads through the raw gRPC path
// (table.bigtable.request({ method: 'readRows' })) because Table.getRows()
// does not support reversed scans. The request stream carries ReadRowsResponse
// payloads whose `chunks` are reassembled by the SDK's ChunkTransformer, so
// the mock table emits chunk payloads instead of getRows() results.

interface TestRow {
  id: string;
  cells: Array<{ family: string; qualifier: string; value: string }>;
}

function buildChunks(row: TestRow): unknown[] {
  return row.cells.map((cell, i) => ({
    ...(i === 0 ? { rowKey: Buffer.from(row.id) } : {}),
    familyName: { value: cell.family },
    qualifier: { value: Buffer.from(cell.qualifier) },
    value: Buffer.from(cell.value),
    timestampMicros: 0,
    ...(i === row.cells.length - 1 ? { commitRow: true } : {}),
  }));
}

function makeTable(rows: TestRow[]) {
  return {
    bigtable: {
      request: jest.fn(() =>
        Readable.from(rows.map((r) => ({ chunks: buildChunks(r) }))),
      ),
    },
    row: (key: string) => ({ id: key }),
  };
}

function row(id: string, families: Record<string, Record<string, string>>): TestRow {
  return {
    id,
    cells: Object.entries(families).flatMap(([family, quals]) =>
      Object.entries(quals).map(([qualifier, value]) => ({ family, qualifier, value })),
    ),
  };
}

describe('getDeviceTimeSeries', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty rows and columns when no data found', async () => {
    const mockTable = makeTable([]);
    (getTelemetryTable as jest.Mock).mockReturnValue(mockTable);

    const result = await getDeviceTimeSeries('dev-001', '1h');

    expect(result).toEqual({ deviceId: 'dev-001', columns: [], rows: [], nextCursor: null, hasMore: false });
  });

  it('extracts rows and unions column names across all rows', async () => {
    const mockTable = makeTable([
      row('dev-001#2024-01-01T00:00:00.000Z', { dynamic: { temp: '25.0' } }),
      row('dev-001#2024-01-01T00:01:00.000Z', { dynamic: { temp: '26.0', soc: '85' } }),
    ]);
    (getTelemetryTable as jest.Mock).mockReturnValue(mockTable);

    const result = await getDeviceTimeSeries('dev-001', '1h');

    expect(result.deviceId).toBe('dev-001');
    expect(result.columns).toContain('dynamic:temp');
    expect(result.columns).toContain('dynamic:soc');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].values['dynamic:temp']).toBe('25.0');
    expect(result.rows[1].values['dynamic:soc']).toBe('85');
  });

  it('constructs row-key bounds correctly including the # separator', async () => {
    const mockTable = makeTable([]);
    (getTelemetryTable as jest.Mock).mockReturnValue(mockTable);

    const before = new Date();
    await getDeviceTimeSeries('dev-001', '1h');
    const after = new Date();

    const reqOpts = mockTable.bigtable.request.mock.calls[0][0].reqOpts;
    const range = reqOpts.rows.rowRanges[0];
    const startValue = range.startKeyClosed.toString();
    const endValue = range.endKeyOpen.toString();

    expect(startValue).toMatch(/^dev-001#/);
    expect(endValue).toMatch(/^dev-001#/);

    const startTs = new Date(startValue.slice('dev-001#'.length));
    const endTs = new Date(endValue.slice('dev-001#'.length));

    expect(before.getTime() - startTs.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(before.getTime() - startTs.getTime()).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
    expect(endTs.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(endTs.getTime()).toBeLessThanOrEqual(after.getTime());

    expect(reqOpts.reversed).toBe(true);
    expect(reqOpts.rowsLimit).toBe(DEFAULT_PAGE_SIZE + 1);
  });

  it('returns hasMore=false and nextCursor=null when fewer rows than limit', async () => {
    const mockTable = makeTable([
      row('dev-001#2024-01-01T00:00:00.000Z', { dynamic: { temp: '25' } }),
    ]);
    (getTelemetryTable as jest.Mock).mockReturnValue(mockTable);

    const result = await getDeviceTimeSeries('dev-001', '1h', undefined, 25);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.rows).toHaveLength(1);
  });

  it('returns hasMore=true and nextCursor when limit+1 rows are returned', async () => {
    const pageSize = 2;
    // Bigtable returns limit+1 = 3 rows
    const mockTable = makeTable([
      row('dev-001#2024-01-01T00:00:00.000Z', { dynamic: { temp: '1' } }),
      row('dev-001#2024-01-01T00:01:00.000Z', { dynamic: { temp: '2' } }),
      row('dev-001#2024-01-01T00:02:00.000Z', { dynamic: { temp: '3' } }),
    ]);
    (getTelemetryTable as jest.Mock).mockReturnValue(mockTable);

    const result = await getDeviceTimeSeries('dev-001', '1h', undefined, pageSize);

    expect(result.hasMore).toBe(true);
    expect(result.rows).toHaveLength(pageSize); // extra row stripped
    expect(result.nextCursor).not.toBeNull();
    // nextCursor is base64 of the last row key on the page
    const decoded = Buffer.from(result.nextCursor!, 'base64').toString('utf8');
    expect(decoded).toBe('dev-001#2024-01-01T00:01:00.000Z');
  });

  it('passes decoded cursor as the exclusive upper bound', async () => {
    const mockTable = makeTable([]);
    (getTelemetryTable as jest.Mock).mockReturnValue(mockTable);

    const rawCursor = 'dev-001#2024-01-01T01:00:00.000Z';

    await getDeviceTimeSeries('dev-001', '1h', rawCursor, 25);

    const reqOpts = mockTable.bigtable.request.mock.calls[0][0].reqOpts;
    expect(reqOpts.rows.rowRanges[0].endKeyOpen.toString()).toBe(rawCursor);
  });

  it('requests limit+1 rows from Bigtable', async () => {
    const mockTable = makeTable([]);
    (getTelemetryTable as jest.Mock).mockReturnValue(mockTable);

    await getDeviceTimeSeries('dev-001', '1h', undefined, 10);

    const reqOpts = mockTable.bigtable.request.mock.calls[0][0].reqOpts;
    expect(reqOpts.rowsLimit).toBe(11);
  });
});
