package com.nexus.sdv.telemetrychartservice.service;

import com.google.cloud.bigtable.data.v2.BigtableDataClient;
import com.google.cloud.bigtable.data.v2.models.*;
import com.google.cloud.bigtable.admin.v2.BigtableTableAdminClient;
import com.google.cloud.bigtable.admin.v2.BigtableTableAdminSettings;
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
import java.util.concurrent.ConcurrentHashMap;
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
    private static final String DYNAMIC_FAMILY = "dynamic";
    private static final String STATIC_FAMILY = "static";

    private final String projectId;
    private final String instanceId;
    private final String tableId;
    private final String emulatorHost;

    private BigtableDataClient dataClient;
    private BigtableTableAdminClient adminClient;

    // Live subscriptions tracking: vehicleId -> Set of column qualifiers
    private final Map<String, Set<String>> liveSubscriptions = new ConcurrentHashMap<>();

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

            BigtableTableAdminSettings adminSettings = BigtableTableAdminSettings.newBuilder()
                    .setProjectId(projectId)
                    .setInstanceId(instanceId)
                    .build();

            if (emulatorHost != null && !emulatorHost.isEmpty()) {
                System.setProperty("BIGTABLE_EMULATOR_HOST", emulatorHost);
            }
            adminClient = BigtableTableAdminClient.create(adminSettings);

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
        if (adminClient != null) {
            adminClient.close();
        }
    }

    /**
     * Query telemetry for a vehicle within a time range
     */
    public List<TelemetryPoint> queryTelemetry(String vehicleId, Instant startTime, Instant endTime,
                                               List<String> columns) {
        String startKey = buildRowKey(vehicleId, startTime);
        String endKey = buildRowKey(vehicleId, endTime);

        log.debug("Querying telemetry: vehicle={}, start={}, end={}, columns={}",
                vehicleId, startKey, endKey, columns);

        Query query = Query.create(tableId)
                .range(startKey, endKey)
                .filter(buildColumnFilter(columns));

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
        String startKey = vehicleId + "#";
        String endKey = vehicleId + "0"; // Lexicographically after all timestamps

        Query query = Query.create(tableId)
                .range(startKey, endKey)
                .filter(buildColumnFilter(columns))
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
    private String buildRowKey(String vehicleId, Instant timestamp) {
        String ts = BIGTABLE_FORMATTER.format(timestamp);
        return vehicleId + "#" + ts;
    }

    /**
     * Parse Bigtable row into TelemetryPoint
     */
    private TelemetryPoint parseRow(Row row, List<String> requestedColumns) {
        String rowKey = row.getKey().toStringUtf8();
        Matcher matcher = ROW_KEY_PATTERN.matcher(rowKey);

        Instant timestamp = Instant.now();
        if (matcher.matches()) {
            String tsStr = matcher.group(2);
            try {
                timestamp = Instant.parse(tsStr);
            } catch (Exception e) {
                log.warn("Failed to parse timestamp from row key: {}", rowKey);
            }
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

        // Group by family
        Map<String, Set<String>> familyToQualifiers = new HashMap<>();
        for (String col : columns) {
            String[] parts = col.split(":", 2);
            if (parts.length == 2) {
                familyToQualifiers.computeIfAbsent(parts[0], k -> new HashSet<>()).add(parts[1]);
            }
        }

        if (familyToQualifiers.isEmpty()) {
            return Filters.FILTERS.pass();
        }

        // Build family filters and combine with interleave
        Filters.InterleaveFilter interleave = Filters.FILTERS.interleave();
        for (Map.Entry<String, Set<String>> entry : familyToQualifiers.entrySet()) {
            String family = entry.getKey();
            Set<String> qualifiers = entry.getValue();

            // Build qualifier regex filter
            String qualifierRegex = "^(" + String.join("|", qualifiers.stream()
                    .map(Pattern::quote)
                    .toList()) + ")$";

            Filters.Filter qualFilter = Filters.FILTERS.qualifier().regex(qualifierRegex);
            Filters.Filter familyFilter = Filters.FILTERS.family().exactMatch(family);

            // Add both filters to interleave
            interleave.filter(familyFilter);
            interleave.filter(qualFilter);
        }

        return interleave;
    }

    // Live subscription management
    public void subscribeLive(String vehicleId, Set<String> columns) {
        liveSubscriptions.compute(vehicleId, (k, v) -> {
            if (v == null) v = ConcurrentHashMap.newKeySet();
            v.addAll(columns);
            return v;
        });
    }

    public void unsubscribeLive(String vehicleId, Set<String> columns) {
        liveSubscriptions.computeIfPresent(vehicleId, (k, v) -> {
            v.removeAll(columns);
            return v.isEmpty() ? null : v;
        });
    }

    public Map<String, Set<String>> getLiveSubscriptions() {
        return new HashMap<>(liveSubscriptions);
    }

    public record TelemetryPoint(Instant timestamp, Map<String, String> values) {}
}