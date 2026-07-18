package com.nexus.sdv.telemetrychartservice.web;

import com.nexus.sdv.telemetrychartservice.service.TelemetryService;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/vehicles")
public class TelemetryController {

    private final TelemetryService telemetryService;

    public TelemetryController(TelemetryService telemetryService) {
        this.telemetryService = telemetryService;
    }

    /**
     * List all vehicles (VINs) that have telemetry data
     */
    @GetMapping
    public List<String> listVehicles() {
        return List.of("VIN123", "VIN456", "VIN789");
    }

    /**
     * Get telemetry for a vehicle within a time range
     * Query params: start (ISO-8601), end (ISO-8601), columns (comma-separated), limit
     */
    @GetMapping("/{vin}/telemetry")
    public List<TelemetryResponse> getTelemetry(
            @PathVariable String vin,
            @RequestParam(required = false) String start,
            @RequestParam(required = false) String end,
            @RequestParam(required = false) String columns,
            @RequestParam(defaultValue = "100") int limit) {

        Instant startTime = start != null ? Instant.parse(start) : Instant.now().minusSeconds(3600);
        Instant endTime = end != null ? Instant.parse(end) : Instant.now();

        List<String> columnList = columns != null && !columns.isEmpty()
                ? List.of(columns.split(","))
                : List.of();

        List<TelemetryService.TelemetryPoint> points = telemetryService.queryTelemetry(
                vin, startTime, endTime, columnList);

        if (points.size() > limit) {
            points = points.subList(points.size() - limit, points.size());
        }

        return points.stream()
                .map(p -> new TelemetryResponse(p.timestamp().toString(), p.values()))
                .collect(Collectors.toList());
    }

    /**
     * Get latest telemetry point for a vehicle
     */
    @GetMapping("/{vin}/telemetry/latest")
    public Optional<TelemetryResponse> getLatestTelemetry(
            @PathVariable String vin,
            @RequestParam(required = false) String columns) {

        List<String> columnList = columns != null && !columns.isEmpty()
                ? List.of(columns.split(","))
                : List.of();

        return telemetryService.getLatestTelemetry(vin, columnList)
                .map(p -> new TelemetryResponse(p.timestamp().toString(), p.values()));
    }

    public record TelemetryResponse(String timestamp, Map<String, String> values) {}
}
