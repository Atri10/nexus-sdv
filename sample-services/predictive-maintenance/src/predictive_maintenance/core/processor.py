from datetime import datetime, timedelta

from predictive_maintenance.client.generated.dataapi.v1 import TelemetryDataApiStub, GetTelemetryDataRequest
from predictive_maintenance.config.config import settings
from predictive_maintenance.config.logging import logger
from predictive_maintenance.client.nats_client import NatsConnector
from predictive_maintenance.core.detectors import (
    BATTERY_BETA,
    BATTERY_V_REF,
    detect_battery,
    detect_brake,
    detect_tires,
)
from predictive_maintenance.model.pm_message import PmMessage

# Brake pad energy budget: 6 GJ over pad life (1500 kg vehicle).
BRAKE_ENERGY_BUDGET_J = 6.0e9
VEHICLE_MASS_KG = 1500.0


class Processor:
    def __init__(self, connector: TelemetryDataApiStub, nats: NatsConnector):
        self._dataApi = connector
        self._nats = nats

    async def run(self, vin: str):
        end = datetime.now()
        start = end - timedelta(days=settings.battery_window_days)
        request = GetTelemetryDataRequest(
            vehicle_id=vin,
            data_types=[
                "dynamic:battery.voltage", "dynamic:battery.soc", "dynamic:battery.temp",
                "dynamic:VELOCITY", "dynamic:acceleration_modulus_m_s2",
                "dynamic:brake_pedal_pct", "dynamic:distance_meters",
                "dynamic:TIRE_PRESSURE", "dynamic:TIRE_TEMP",
            ],
            last_duration=timedelta(seconds=settings.battery_window_days * 86400),
        )
        logger.info("Polling data-api for predictive-maintenance analysis", vehicle_id=vin)
        rest, crank, brake_energy, tires = [], [], 0.0, []
        batt_temp = BATTERY_V_REF  # last-known battery temp (°C); default = reference (no-op)
        try:
            async for point in self._dataApi.get_telemetry_data(request):
                ts = point.timestamp.time().strftime("%H:%M:%S")
                v = lambda k: point.values.get(k)  # noqa: E731
                if v("dynamic:battery.temp"):
                    batt_temp = float(v("dynamic:battery.temp").decode().strip('"'))
                if v("dynamic:battery.voltage"):
                    rest.append((datetime.now().timestamp(),
                                 float(v("dynamic:battery.voltage").decode().strip('"')),
                                 batt_temp))
                if v("dynamic:TIRE_PRESSURE") and v("dynamic:TIRE_TEMP"):
                    tires.append((datetime.now().timestamp(),
                                  float(v("dynamic:TIRE_PRESSURE").decode().strip('"')),
                                  float(v("dynamic:TIRE_TEMP").decode().strip('"')) + 273.15))
                if v("dynamic:acceleration_modulus_m_s2") and v("dynamic:VELOCITY") and v("dynamic:brake_pedal_pct"):
                    a = float(v("dynamic:acceleration_modulus_m_s2").decode().strip('"'))
                    vel = float(v("dynamic:VELOCITY").decode().strip('"'))
                    brake_pct = float(v("dynamic:brake_pedal_pct").decode().strip('"'))
                    if brake_pct > 5.0 and a > 0.5 and vel > 0.5:
                        brake_energy += 1500.0 * a * vel * settings.poll_interval_seconds  # m·a·v·dt
        except Exception as e:
            logger.error("Data poll failed", vehicle_id=vin, error=repr(e))
            return
        results = {}
        if rest:
            # Temperature-compensate resting voltages to the 30 °C reference
            # BEFORE detection (detect_battery consumes compensated V):
            # V_comp = V - BATTERY_BETA * (T - BATTERY_V_REF); T = last-known battery temp.
            comp = [(t, v0 - BATTERY_BETA * (t0 - BATTERY_V_REF)) for t, v0, t0 in rest]
            results["battery"] = detect_battery(comp, crank)
        if brake_energy > 0:
            results["brake"] = detect_brake(min(1.0, brake_energy / BRAKE_ENERGY_BUDGET_J))  # E_budget 6 GJ
        if tires:
            results["tires"] = detect_tires(tires)
        if not self._nats.is_connected:
            self._nats.connect()
        for component, r in results.items():
            if r.severity == "healthy":
                continue  # publish only on change/band-crossing; healthy = nothing
            await self._nats.publish_message(
                f"pm.{vin}.{component}",
                PmMessage(vin=vin, component=component, health_score=r.health_score,
                          severity=r.severity, evidence=r.evidence,
                          explanation=r.explanation,
                          timestamp=datetime.now().isoformat()))
