package com.nexus.sdv.telemetrychartservice.service;

import com.google.cloud.bigtable.data.v2.BigtableDataClient;
import com.google.cloud.bigtable.data.v2.models.*;
import com.google.cloud.bigtable.data.v2.BigtableDataSettings;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Service
public class TelemetryService {

    private static final Logger log = LoggerFactory.getLogger(TelemetryService.class);
    private static final String BIGTABLE_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH:mm:ss.SSSSSSSSSX";
    private static final DateTimeFormatter BIGTABLE_FORMATTER =
        DateTimeFormatter.ofPattern(BIGTABLE_TIMESTAMP_FORMAT).withZone(ZoneOffset.UTC);
    private static final Pattern ROW_KEY_PATTERN = Pattern.compile("^(.+)#(.+)$");

    private final String projectId;
    private final String instanceId;
    private final String tableId;
    private final String emulatorHost;

    private BigtableDataClient dataClient;

    public TelemetryService(
            @Value("${bigtable.project-id:test-project}") String projectId,
            @Value("${bigtable.instance-id:test-instance}") String instanceId,
            @Value("${bigtable.table-name:telemetry}") String tableId,
            @Value("${bigtable.emulator-host:}") String emulatorHost) {
        this.projectId = projectId;
        this.instanceId = instanceId;
        this.tableId = tableId;
        this.emulatorHost = emulatorHost;
    }

    @PostConstruct
    public void init() {
        try {
            BigtableDataSettings.Builder settingsBuilder = BigtableDataSettings.newBuilder()
                    .setProjectId(projectId)
                    .setInstanceId(instanceId);

            if (emulatorHost != null && !emulatorHost.isEmpty()) {
                System.setProperty("BIGTABLE_EMULATOR_HOST", emulatorHost);
            }

            dataClient = BigtableDataClient.create(settingsBuilder.build());

            log.info("Bigtable client initialized: project={}, instance={}, table={}, emulator={}",
                    projectId, instanceId, tableId, emulatorHost);
        } catch (IOException e) {
            log.error("Failed to initialize Bigtable client", e);
            throw new RuntimeException(e);
        }
    }

    @PreDestroy
    public void close() {
        if (dataClient != null) {
            dataClient.close();
        }
    }

    /**
     * Query telemetry for a vehicle within a time range
     */
    public List<TelemetryPoint> queryTelemetry(String vehicleId, Instant startTime, Instant endTime,
                                               List<String> columns, int limit) {
        String startKey = buildRowKey(vehicleId, startTime);
        String endKey = buildEndKeyInclusive(vehicleId, endTime);

        log.debug("Querying telemetry: vehicle={}, start={}, end={}, columns={}",
                vehicleId, startKey, endKey, columns);

        Query query = Query.create(tableId)
                .range(startKey, endKey)
                .filter(Filters.FILTERS.chain()
                        .filter(Filters.FILTERS.key().regex(vehicleKeyRegex(vehicleId)))
                        .filter(buildColumnFilter(columns)))
                .limit(limit)
                .reversed(true);

        List<TelemetryPoint> results = new ArrayList<>();

        try {
            dataClient.readRows(query).forEach(row -> {
                TelemetryPoint point = parseRow(row, columns);
                if (point != null) {
                    results.add(point);
                }
            });
        } catch (Exception e) {
            log.error("Error querying telemetry for vehicle {}: {}", vehicleId, e.getMessage(), e);
        }

        // Sort by timestamp ascending
        results.sort(Comparator.comparing(TelemetryPoint::timestamp));
        return results;
    }

    /**
     * Get latest telemetry point for a vehicle
     */
    public Optional<TelemetryPoint> getLatestTelemetry(String vehicleId, List<String> columns) {
        Query query = Query.create(tableId)
                .range(vehicleId + "#", vehicleId + "#\uffff")
                .filter(Filters.FILTERS.chain()
                        .filter(Filters.FILTERS.key().regex(vehicleKeyRegex(vehicleId)))
                        .filter(buildColumnFilter(columns)))
                .limit(1)
                .reversed(true);

        try {
            Row latestRow = dataClient.readRows(query).stream().findFirst().orElse(null);

            if (latestRow != null) {
                return Optional.ofNullable(parseRow(latestRow, columns));
            }
        } catch (Exception e) {
            log.error("Error getting latest telemetry for vehicle {}: {}", vehicleId, e.getMessage(), e);
        }

        return Optional.empty();
    }

    /**
     * Build Bigtable row key: VIN#timestamp (RFC3339Nano format)
     */
    static String buildRowKey(String vehicleId, Instant timestamp) {
        String ts = BIGTABLE_FORMATTER.format(timestamp);
        return vehicleId + "#" + ts;
    }

    /**
     * RE2-safe regex escape (Bigtable filters do NOT support Java's \Q...\E).
     */
    static String escapeRegex(String input) {
        return input.replaceAll("([.^$*+?()\\[\\]{}|\\\\-])", "\\\\$1");
    }

    /**
     * Key regex matching exactly this vehicle's rows (VIN#...), never
     * sibling-prefixed VINs like VIN123-... or VIN1230#... .
     */
    static String vehicleKeyRegex(String vehicleId) {
        return "^" + escapeRegex(vehicleId) + "#.*";
    }

    /**
     * Exclusive end key that includes the exact end instant:
     * Bigtable ranges are half-open [start, end).
     */
    static String buildEndKeyInclusive(String vehicleId, Instant endTime) {
        return buildRowKey(vehicleId, endTime.plusNanos(1));
    }

    /**
     * Parse Bigtable row into TelemetryPoint
     */
    private TelemetryPoint parseRow(Row row, List<String> requestedColumns) {
        String rowKey = row.getKey().toStringUtf8();
        Matcher matcher = ROW_KEY_PATTERN.matcher(rowKey);

        if (!matcher.matches()) {
            log.warn("Skipping row with unparseable key (no VIN#timestamp shape): {}", rowKey);
            return null;
        }
        Instant timestamp;
        try {
            timestamp = Instant.parse(matcher.group(2));
        } catch (Exception e) {
            log.warn("Skipping row with unparseable timestamp in key {}: {}", rowKey, e.getMessage());
            return null;
        }

        Map<String, String> values = new HashMap<>();
        for (RowCell cell : row.getCells()) {
            String family = cell.getFamily();
            String qualifier = cell.getQualifier().toStringUtf8();
            String value = cell.getValue().toStringUtf8();
            String columnKey = family + ":" + qualifier;

            // Filter by requested columns if specified
            if (requestedColumns == null || requestedColumns.isEmpty() || requestedColumns.contains(columnKey)) {
                values.put(columnKey, value);
            }
        }

        if (values.isEmpty()) {
            return null;
        }

        return new TelemetryPoint(timestamp, values);
    }

    /**
     * Build column filter from requested columns
     */
    private Filters.Filter buildColumnFilter(List<String> columns) {
        if (columns == null || columns.isEmpty()) {
            return Filters.FILTERS.pass();
        }

        Map<String, Set<String>> familyToQualifiers = new HashMap<>();
        for (String col : columns) {
            String[] parts = col.split(":", 2);
            String family = parts.length == 2 ? parts[0] : "dynamic";
            String qualifier = parts[parts.length - 1];
            familyToQualifiers.computeIfAbsent(family, k -> new HashSet<>()).add(qualifier);
        }

        List<Filters.Filter> chains = new ArrayList<>();
        for (Map.Entry<String, Set<String>> entry : familyToQualifiers.entrySet()) {
            String qualifierRegex = "^(" + entry.getValue().stream()
                    .map(TelemetryService::escapeRegex)
                    .collect(Collectors.joining("|")) + ")$";
            chains.add(Filters.FILTERS.chain()
                    .filter(Filters.FILTERS.family().exactMatch(entry.getKey()))
                    .filter(Filters.FILTERS.qualifier().regex(qualifierRegex)));
        }

        if (chains.size() == 1) {
            return chains.get(0);
        }
        Filters.InterleaveFilter interleave = Filters.FILTERS.interleave();
        for (Filters.Filter chain : chains) {
            interleave.filter(chain);
        }
        return interleave;
    }

    /**
     * List all vehicles (VINs) that have telemetry data
     */
    public List<String> listVehicles() {
        Set<String> vins = new TreeSet<>();
        Query query = Query.create(tableId)
                .filter(Filters.FILTERS.key().regex("^[^#]+#.*"))
                .limit(1000);
        try {
            dataClient.readRows(query).forEach(row -> {
                String key = row.getKey().toStringUtf8();
                int hash = key.indexOf('#');
                if (hash > 0) {
                    vins.add(key.substring(0, hash));
                }
            });
        } catch (Exception e) {
            log.error("Error listing vehicles", e);
        }
        return new ArrayList<>(vins);
    }

    public record TelemetryPoint(Instant timestamp, Map<String, String> values) {}
}
