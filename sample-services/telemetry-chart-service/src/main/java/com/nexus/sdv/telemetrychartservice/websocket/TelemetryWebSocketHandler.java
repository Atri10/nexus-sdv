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
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
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
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        log.info("WebSocket connection established: sessionId={}, path={}", session.getId(), session.getUri());
        String vin = extractVin(session);
        if (vin == null) {
            log.warn("Could not extract VIN from session: {}", session.getUri());
            try {
                session.close(CloseStatus.BAD_DATA.withReason("VIN not found in path"));
            } catch (IOException e) {
                log.error("Failed to close session", e);
            }
            return;
        }

        SessionInfo info = new SessionInfo(session, vin, ConcurrentHashMap.newKeySet());
        sessions.put(session.getId(), info);

        log.info("WebSocket connected: sessionId={}, vin={}", session.getId(), vin);

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
            Map<String, Object> msg = objectMapper.readValue(message.getPayload(), Map.class);
            String type = (String) msg.get("type");

            if ("subscribe".equals(type)) {
                @SuppressWarnings("unchecked")
                List<String> columns = (List<String>) msg.get("columns");
                handleSubscribe(session, info, new HashSet<>(columns));
            } else if ("unsubscribe".equals(type)) {
                @SuppressWarnings("unchecked")
                List<String> columns = (List<String>) msg.get("columns");
                handleUnsubscribe(session, info, new HashSet<>(columns));
            } else if ("ping".equals(type)) {
                sendMessage(session, Map.of("type", "pong"));
            }
        } catch (Exception e) {
            log.error("Error handling WebSocket message", e);
            sendError(session, "Invalid message format");
        }
    }

    private void handleSubscribe(WebSocketSession session, SessionInfo info, Set<String> columns) {
        if (columns != null) {
            info.subscribedColumns().addAll(columns);
        }
        sendMessage(session, Map.of("type", "subscribed", "vehicleId", info.vin(), "columns", info.subscribedColumns()));
    }

    private void handleUnsubscribe(WebSocketSession session, SessionInfo info, Set<String> columns) {
        if (columns != null) {
            info.subscribedColumns().removeAll(columns);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String sessionId = session.getId();
        SessionInfo info = sessions.remove(sessionId);
        if (info != null) {
            cancelPoll(info);
            log.info("WebSocket disconnected: sessionId={}, vin={}, reason={}", sessionId, info.vin(), status);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.error("WebSocket transport error: sessionId={}", session.getId(), exception);
        SessionInfo info = sessions.get(session.getId());
        if (info != null) {
            cancelPoll(info);
        }
    }

    @PreDestroy
    public void shutdown() {
        scheduler.shutdownNow();
        sessions.values().forEach(this::cancelPoll);
    }

    private void cancelPoll(SessionInfo info) {
        ScheduledFuture<?> task = info.pollTask();
        if (task != null) {
            task.cancel(false);
            info.pollTask(null);
        }
    }

    private void startPolling(SessionInfo info) {
        info.pollTask(scheduler.scheduleAtFixedRate(() -> {
            try {
                // Empty subscribedColumns means "all columns" (server-side pass() filter);
                // the web client never sends a subscribe message, so always poll.
                Optional<TelemetryService.TelemetryPoint> latest = telemetryService.getLatestTelemetry(info.vin(), new ArrayList<>(info.subscribedColumns()));
                if (latest.isPresent()) {
                    TelemetryService.TelemetryPoint point = latest.get();
                    String pointKey = point.timestamp().toString();
                    if (pointKey.equals(info.lastSentTimestamp())) {
                        return;
                    }
                    info.lastSentTimestamp(pointKey);
                    Map<String, Object> message = new HashMap<>();
                    message.put("type", "telemetry");
                    message.put("vehicleId", info.vin());
                    message.put("timestamp", point.timestamp().toString());
                    message.put("values", point.values());
                    sendMessage(info.session(), message);
                }
            } catch (Exception e) {
                log.error("Error polling telemetry for {}", info.vin(), e);
            }
        }, 1, 1, TimeUnit.SECONDS));
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
        // Expected format: /api/v1/vehicles/{vin}/telemetry/live
        String prefix = "/api/v1/vehicles/";
        int start = uri.indexOf(prefix);
        if (start == -1) {
            return null;
        }
        start += prefix.length();
        int end = uri.indexOf('/', start);
        if (end == -1) {
            end = uri.length();
        }
        return uri.substring(start, end);
    }

    // SessionInfo as a regular class instead of record to allow mutable fields
    private static class SessionInfo {
        private final WebSocketSession session;
        private final String vin;
        private final Set<String> subscribedColumns;
        private volatile String lastSentTimestamp;
        private volatile ScheduledFuture<?> pollTask;

        public SessionInfo(WebSocketSession session, String vin, Set<String> subscribedColumns) {
            this.session = session;
            this.vin = vin;
            this.subscribedColumns = subscribedColumns;
        }

        public WebSocketSession session() { return session; }
        public String vin() { return vin; }
        public Set<String> subscribedColumns() { return subscribedColumns; }
        public String lastSentTimestamp() { return lastSentTimestamp; }
        public void lastSentTimestamp(String v) { this.lastSentTimestamp = v; }
        public ScheduledFuture<?> pollTask() { return pollTask; }
        public void pollTask(ScheduledFuture<?> pollTask) { this.pollTask = pollTask; }
    }
}