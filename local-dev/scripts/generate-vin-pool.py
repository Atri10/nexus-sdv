#!/usr/bin/env python3
"""Generate the per-VIN Keycloak client pool for local-dev.

Prints two JSON fragments to stdout:
  --clients   one client object per VIN (VIN1001..VIN1010)
  --users     one service-account user object per VIN
The realm import (keycloak/nexus-realm.json) embeds these; re-run and paste
whenever the pool changes. Deterministic output (fixed order, no randomness).
"""
import sys

POOL_SIZE = 10
PREFIX = "VIN10"


def client(vin: str, idx: int) -> str:
    secret = f"{vin.lower()}-secret"
    return f"""    {{
      "clientId": "{vin}",
      "name": "Vehicle Client {vin}",
      "description": "Per-VIN confidential client; azp={vin} so auth-callout grants telemetry.{vin}.> and commands.{vin}.>",
      "rootUrl": "",
      "adminUrl": "",
      "baseUrl": "",
      "surrogateAuthRequired": false,
      "enabled": true,
      "alwaysDisplayInConsole": false,
      "clientAuthenticatorType": "client-secret",
      "secret": "{secret}",
      "redirectUris": ["*"],
      "webOrigins": ["*"],
      "notBefore": 0,
      "bearerOnly": false,
      "consentRequired": false,
      "standardFlowEnabled": true,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "serviceAccountsEnabled": true,
      "publicClient": false,
      "frontchannelLogout": false,
      "protocol": "openid-connect",
      "attributes": {{
        "oauth2.device.authorization.grant.enabled": "false",
        "oidc.ciba.grant.enabled": "false",
        "client.secret.creation.time": "0"
      }},
      "authenticationFlowBindingOverrides": {{}},
      "fullScopeAllowed": true,
      "nodeReRegistrationTimeout": -1,
      "protocolMappers": [
        {{
          "name": "realm roles",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-realm-role-mapper",
          "consentRequired": false,
          "config": {{
            "multivalued": "true",
            "userinfo.token.claim": "true",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "claim.name": "realm_access.roles",
            "jsonType.label": "String"
          }}
        }}
      ]
    }}"""


def user(vin: str) -> str:
    return f"""    {{
      "username": "service-account-{vin.lower()}",
      "enabled": true,
      "emailVerified": false,
      "serviceAccountClientId": "{vin}",
      "realmRoles": ["edge-device", "telemetry-client"]
    }}"""


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    vins = [f"{PREFIX}{i:02d}" for i in range(1, POOL_SIZE + 1)]
    if mode == "--clients":
        print(",\n".join(client(v, i) for i, v in enumerate(vins)))
    elif mode == "--users":
        print(",\n".join(user(v) for v in vins))
    else:
        print("usage: generate-vin-pool.py --clients|--users", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
