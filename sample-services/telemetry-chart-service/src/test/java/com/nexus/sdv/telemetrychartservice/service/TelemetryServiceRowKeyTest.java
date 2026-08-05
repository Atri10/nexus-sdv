package com.nexus.sdv.telemetrychartservice.service;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

class TelemetryServiceRowKeyTest {

    @Test
    void vehicleKeyRegexMatchesOnlyOwnPrefix() {
        Pattern p = Pattern.compile(TelemetryService.vehicleKeyRegex("VIN123"));
        assertTrue(p.matcher("VIN123#2026-08-05T00:00:00.000000000Z").matches());
        assertFalse(p.matcher("VIN1230#2026-08-05T00:00:00.000000000Z").matches());
        assertFalse(p.matcher("VIN123-OTHER#2026-08-05T00:00:00.000000000Z").matches());
        assertFalse(p.matcher("VIN12#2026-08-05T00:00:00.000000000Z").matches());
    }

    @Test
    void escapeRegexHandlesRegexMetacharacters() {
        assertEquals("VIN123", TelemetryService.escapeRegex("VIN123"));
        assertFalse(Pattern.compile(TelemetryService.escapeRegex("VIN.123"))
                .matcher("VINX123").matches());
        assertTrue(Pattern.compile(TelemetryService.escapeRegex("VIN.123"))
                .matcher("VIN.123").matches());
    }

    @Test
    void inclusiveEndKeyIsStrictlyAfterExactEndInstant() {
        Instant end = Instant.parse("2026-08-05T00:00:00.123456789Z");
        String endKey = TelemetryService.buildEndKeyInclusive("VIN123", end);
        String exact = TelemetryService.buildRowKey("VIN123", end);
        assertTrue(endKey.compareTo(exact) > 0);
    }
}
