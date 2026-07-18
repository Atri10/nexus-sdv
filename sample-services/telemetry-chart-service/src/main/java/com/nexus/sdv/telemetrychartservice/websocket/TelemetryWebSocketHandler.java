package com.nexus.sdv.telemetrychartservice.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nexus.sdv.telemetrychartservice.service.TelemetryService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

@Component
public class TelemetryWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(TelemetryWebSocketHandler.class);
    private static final ObjectMapper objectMapper = new ObjectMapper();

    private final TelemetryService telemetryService;
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);

    // Active sessions: sessionId -> SessionInfo
    private final Map<String, SessionInfo> sessions = new ConcurrentHashMap<>();

    public TelemetryWebSocketHandler(TelemetryService telemetryService) {
        this.telemetryService = telemetryService;
        // Start periodic live data broadcast
        scheduler.scheduleAtFixedRate(this::broadcastLiveData, 2, 2, TimeUnit.SECONDS);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String sessionId = session.getId();
        String vin = extractVin(session);

        if (vin == null) {
            log.warn("WebSocket connection without VIN, closing: {}", sessionId);
            try {
                session.close(CloseStatus.BAD_DATA.withReason("VIN required in path"));
            } catch (IOException e) {
                log.error("Error closing session", e);
            }
            return;
        }

        SessionInfo info = new SessionInfo(session, vin, ConcurrentHashMap.newKeySet());
        sessions.put(sessionId, info);

        // Subscribe to live updates
        telemetryService.subscribeLive(vin, info.subscribedColumns());

        log.info("WebSocket connected: sessionId={}, vin={}", sessionId, vin);

        // Start polling for new data
        startPolling(info);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        String sessionId = session.getId();
        SessionInfo info = sessions.get(sessionId);

        if (info == null) {
            return;
        }

        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> msg = objectMapper.readValue(message.getPayload(), Map.class);
            String type = (String) msg.get("type");

            switch (type) {
                case "subscribe" -> handleSubscribe(session, info, msg);
                case "unsubscribe" -> handleUnsubscribe(session, info, msg);
                case "ping" -> sendMessage(session, Map.of("type", "pong", "timestamp", Instant.now().toString()));
                default -> log.warn("Unknown message type: {}", type);
            }
        } catch (Exception e) {
            log.error("Error handling WebSocket message: {}", e.getMessage(), e);
        }
    }

    private void handleSubscribe(WebSocketSession session, SessionInfo info, Map<String, Object> msg) {
        String vehicleId = (String) msg.get("vehicleId");
        @SuppressWarnings("unchecked")
        List<String> columns = (List<String>) msg.getOrDefault("columns", List.of());

        if (vehicleId == null || vehicleId.isEmpty()) {
            sendError(session, "vehicleId is required");
            return;
        }

        info.subscribedColumns().addAll(columns);
        telemetryService.subscribeLive(vehicleId, info.subscribedColumns());

        sendMessage(session, Map.of(
                "type", "subscribed",
                "vehicleId", vehicleId,
                "columns", columns
        ));
        log.info("Session {} subscribed to {} with columns {}", session.getId(), vehicleId, columns);
    }

    private void handleUnsubscribe(WebSocketSession session, SessionInfo info, Map<String, Object> msg) {
        String vehicleId = (String) msg.get("vehicleId");
        @SuppressWarnings("unchecked")
        List<String> columns = (List<String>) msg.getOrDefault("columns", List.of());

        info.subscribedColumns().removeAll(columns);
        telemetryService.unsubscribeLive(vehicleId, new HashSet<>(columns));

        sendMessage(session, Map.of(
                "type", "unsubscribed",
                "vehicleId", vehicleId
        ));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String sessionId = session.getId();
        SessionInfo info = sessions.remove(sessionId);

        if (info != null) {
            telemetryService.unsubscribeLive(info.vin(), info.subscribedColumns());
            if (info.pollTask() != null) {
                info.pollTask().cancel(false);
            }
            log.info("WebSocket disconnected: sessionId={}, vin={}, status={}", sessionId, info.vin(), status);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.error("WebSocket transport error: sessionId={}", session.getId(), exception);
    }

    private void broadcastLiveData() {
        // Get all active subscriptions
        Map<String, Set<String>> allSubs = telemetryService.getLiveSubscriptions();
        if (allSubs.isEmpty()) {
            return;
        }

        for (Map.Entry<String, Set<String>> entry : allSubs.entrySet()) {
            String vehicleId = entry.getKey();
            Set<String> columns = entry.getValue();

            // Get latest data for this vehicle
            Optional<TelemetryService.TelemetryPoint> latest = telemetryService.getLatestTelemetry(vehicleId,
                    new ArrayList<>(columns));

            latest.ifPresent(point -> {
                Map<String, Object> message = Map.of(
                        "type", "telemetry",
                        "vehicleId", vehicleId,
                        "timestamp", point.timestamp().toString(),
                        "values", point.values()
                );

                // Send to all sessions subscribed to this vehicle
                for (Map.Entry<String, SessionInfo> sessionEntry : sessions.entrySet()) {
                    WebSocketSession session = sessionEntry.getValue().session();
                    SessionInfo info = sessionEntry.getValue();
                    if (session != null && session.isOpen() && info.vin().equals(vehicleId)) {
                        sendMessage(session, message);
                    }
                }
            });
        }
    }

    private void startPolling(SessionInfo info) {
        info.pollTask(scheduler.scheduleAtFixedRate(() -> {
            if (!info.session().isOpen()) {
                return;
            }

            try {
                // Query for latest data since last poll
                Instant now = Instant.now();
                Instant since = info.lastPollTime() != null ? info.lastPollTime() : now.minusSeconds(5);

                List<TelemetryService.TelemetryPoint> points = telemetryService.queryTelemetry(
                        info.vin(), since, now, new ArrayList<>(info.subscribedColumns()));

                if (!points.isEmpty()) {
                    info.lastPollTime(points.get(points.size() - 1).timestamp());

                    Map<String, Object> message = Map.of(
                            "type", "telemetry",
                            "vehicleId", info.vin(),
                            "timestamp", Instant.now().toString(),
                            "data", points.stream()
                                    .map(p -> Map.of(
                                            "timestamp", p.timestamp().toString(),
                                            "values", p.values()))
                                    .toList()
                    );

                    sendMessage(info.session(), message);
                }
            } catch (Exception e) {
                log.error("Error polling telemetry for session {}: {}", info.session().getId(), e.getMessage());
            }
        }, 2, 2, TimeUnit.SECONDS));
    }

    private void sendMessage(WebSocketSession session, Object message) {
        if (session.isOpen()) {
            try {
                String json = objectMapper.writeValueAsString(message);
                session.sendMessage(new TextMessage(json));
            } catch (IOException e) {
                log.debug("Failed to send WebSocket message: {}", e.getMessage());
            }
        }
    }

    private void sendError(WebSocketSession session, String error) {
        sendMessage(session, Map.of("type", "error", "message", error));
    }

    private String extractVin(WebSocketSession session) {
        String uri = session.getUri().toString();
        // Extract VIN from /api/v1/vehicles/{vin}/telemetry/live
        String[] parts = uri.split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            if ("vehicles".equals(parts[i])) {
                return parts[i + 1];
            }
        }
        return null;
    }

    // SessionInfo as a regular class instead of record to allow mutable fields
    private static class SessionInfo {
        private final WebSocketSession session;
        private final String vin;
        private final Set<String> subscribedColumns;
        private volatile Instant lastPollTime;
        private volatile java.util.concurrent.ScheduledFuture<?> pollTask;

        public SessionInfo(WebSocketSession session, String vin, Set<String> subscribedColumns) {
            this.session = session;
            this.vin = vin;
            this.subscribedColumns = subscribedColumns;
        }

        public WebSocketSession session() { return session; }
        public String vin() { return vin; }
        public Set<String> subscribedColumns() { return subscribedColumns; }
        public Instant lastPollTime() { return lastPollTime; }
        public void lastPollTime(Instant lastPollTime) { this.lastPollTime = lastPollTime; }
        public java.util.concurrent.ScheduledFuture<?> pollTask() { return pollTask; }
        public void pollTask(java.util.concurrent.ScheduledFuture<?> pollTask) { this.pollTask = pollTask; }
    }
}
