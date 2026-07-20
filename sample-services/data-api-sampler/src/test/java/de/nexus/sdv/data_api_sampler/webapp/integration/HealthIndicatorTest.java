package de.nexus.sdv.data_api_sampler.webapp.integration;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.reactive.AutoConfigureWebTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.reactive.server.EntityExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureWebTestClient
@TestPropertySource(locations = "classpath:application-test.properties")
public class HealthIndicatorTest {

    @LocalServerPort
    private int port;

    private static String BASE_URL = "http://localhost:%d/";

    @Autowired
    private WebTestClient webTestClient;

    @Test
    void healthEndpoint_returnsUp() {
        final EntityExchangeResult<String> stringEntityExchangeResult = webTestClient.get().uri(
                        BASE_URL.formatted(port) + "/health")
                .exchange().expectStatus().isOk()
                .expectBody(String.class)
                .returnResult();

        assertThat(stringEntityExchangeResult.getResponseBody()).contains("\"status\":\"UP\"");
    }
}
