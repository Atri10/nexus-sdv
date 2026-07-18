package com.nexus.sdv.telemetrychartservice.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/actuator/**").permitAll()
                        .requestMatchers("/api/v1/**").permitAll()
                        .requestMatchers("/websocket/**").permitAll()
                        .anyRequest().permitAll() // Allow all for local dev
                )
                .csrf(csrf -> csrf.disable())
                .headers(headers -> headers
                        .frameOptions(frame -> frame.sameOrigin())
                );

        return http.build();
    }
}
