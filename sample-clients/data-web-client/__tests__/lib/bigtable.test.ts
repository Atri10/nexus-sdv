// getTelemetryTable() reads env vars lazily on first call and the module
// singletons start null, so no module reset is needed (bun's test runner has
// no jest.resetModules(), and nothing else in the suite calls the real
// getTelemetryTable).
describe('getTelemetryTable', () => {
  it('returns a Table object pointing at the telemetry table for configured project and instance', () => {
    process.env.BIGTABLE_PROJECT_ID = 'test-project';
    process.env.BIGTABLE_INSTANCE_ID = 'test-instance';

    // Import fresh after env vars are set and modules are reset
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTelemetryTable } = require('@/lib/bigtable');
    const table = getTelemetryTable();

    // The SDK builds a full resource path from the env vars
    expect(table.name).toBe(
      'projects/test-project/instances/test-instance/tables/telemetry'
    );
  });
});
