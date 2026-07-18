package com.nexus.sdv.telemetrychartservice.config;

import com.google.cloud.bigtable.admin.v2.BigtableTableAdminClient;
import com.google.cloud.bigtable.admin.v2.BigtableTableAdminSettings;
import com.google.cloud.bigtable.data.v2.BigtableDataClient;
import com.google.cloud.bigtable.data.v2.BigtableDataSettings;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.io.IOException;

@Configuration
public class BigtableConfig {

    @Value("${bigtable.project-id:test-project}")
    private String projectId;

    @Value("${bigtable.instance-id:test-instance}")
    private String instanceId;

    @Value("${bigtable.emulator-host:}")
    private String emulatorHost;

    @Bean
    public BigtableDataClient bigtableDataClient() throws IOException {
        BigtableDataSettings.Builder settingsBuilder = BigtableDataSettings.newBuilder()
                .setProjectId(projectId)
                .setInstanceId(instanceId);

        if (emulatorHost != null && !emulatorHost.isEmpty()) {
            // For emulator, set endpoint via system property (standard approach)
            System.setProperty("BIGTABLE_EMULATOR_HOST", emulatorHost);
        }

        return BigtableDataClient.create(settingsBuilder.build());
    }

    @Bean
    public BigtableTableAdminClient bigtableTableAdminClient() throws IOException {
        BigtableTableAdminSettings.Builder settingsBuilder = BigtableTableAdminSettings.newBuilder()
                .setProjectId(projectId)
                .setInstanceId(instanceId);

        if (emulatorHost != null && !emulatorHost.isEmpty()) {
            System.setProperty("BIGTABLE_EMULATOR_HOST", emulatorHost);
        }

        return BigtableTableAdminClient.create(settingsBuilder.build());
    }
}