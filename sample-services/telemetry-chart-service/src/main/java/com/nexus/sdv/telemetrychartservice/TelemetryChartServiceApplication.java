package com.nexus.sdv.telemetrychartservice;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class TelemetryChartServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(TelemetryChartServiceApplication.class, args);
    }
}
