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
        request = GetTelemetryDataRequest(
            vehicle_id=vin,
            # Qualifiers must match what nats-bigtable-connector actually
            # writes: lowercase battery.* from telemetry-generic
            # TelemetryMessages (reading.Sensor), UPPERCASE typed scalars
            # (VELOCITY, BRAKE_PEDAL_PCT, TIRE_PRESSURE) from telemetry.*
            # MetricsReports. acceleration_modulus_m_s2 / distance_meters are
            # proto fields the connector never persists — requesting them can
            # never return data. TIRE_TEMP lands with Task 5 (proto field 16 +
            # connector mapping + emission); requesting it before then is
            # harmless (the filter matches nothing).
            data_types=[
                "dynamic:battery.voltage", "dynamic:battery.temp",
                "dynamic:VELOCITY", "dynamic:BRAKE_PEDAL_PCT",
                "dynamic:TIRE_PRESSURE", "dynamic:TIRE_TEMP",
                # Per-wheel sensors (Task: runtime VIN switching + per-wheel
                # PM): tires/brakes are modeled per wheel so the detector can
                # report which corner is degrading. The connector stores them
                # as literal dynamic:<name> columns (it is generic per-sensor),
                # and the dot is part of the qualifier, not a separator.
                "dynamic:TIRE_PRESSURE.FL", "dynamic:TIRE_PRESSURE.FR",
                "dynamic:TIRE_PRESSURE.RL", "dynamic:TIRE_PRESSURE.RR",
                "dynamic:TIRE_TEMP.FL", "dynamic:TIRE_TEMP.FR",
                "dynamic:TIRE_TEMP.RL", "dynamic:TIRE_TEMP.RR",
                "dynamic:BRAKE_WEAR.FL", "dynamic:BRAKE_WEAR.FR",
                "dynamic:BRAKE_WEAR.RL", "dynamic:BRAKE_WEAR.RR",
            ],
            last_duration=timedelta(seconds=settings.battery_window_days * 86400),
        )
        logger.info("Polling data-api for predictive-maintenance analysis", vehicle_id=vin)
        rest, crank, brake_energy, tires = [], [], 0.0, []
        # Per-wheel collectors: one (t, P_bar, T_kelvin) series per tire and
        # one wear_fraction per brake pad. Keyed by the wheel label (FL/FR/RL/RR).
        tires_by_wheel = {w: [] for w in ("FL", "FR", "RL", "RR")}
        brake_wear_by_pad = {w: [] for w in ("FL", "FR", "RL", "RR")}
        batt_temp = BATTERY_V_REF  # last-known battery temp (°C); default = reference (no-op)
        prev_brake = None  # (t_epoch, velocity) of the previous braking sample
        try:
            async for point in self._dataApi.get_telemetry_data(request):
                t = point.timestamp.timestamp()  # row's own epoch time — x-coordinate
                v = lambda k: point.values.get(k)  # noqa: E731
                if v("dynamic:battery.temp"):
                    batt_temp = float(v("dynamic:battery.temp").decode().strip('"'))
                if v("dynamic:battery.voltage"):
                    rest.append((t,
                                 float(v("dynamic:battery.voltage").decode().strip('"')),
                                 batt_temp))
                if v("dynamic:TIRE_PRESSURE") and v("dynamic:TIRE_TEMP"):
                    tires.append((t,
                                  float(v("dynamic:TIRE_PRESSURE").decode().strip('"')),
                                  float(v("dynamic:TIRE_TEMP").decode().strip('"')) + 273.15))
                for w in ("FL", "FR", "RL", "RR"):
                    pw, tw = f"dynamic:TIRE_PRESSURE.{w}", f"dynamic:TIRE_TEMP.{w}"
                    if v(pw) and v(tw):
                        tires_by_wheel[w].append((t,
                                                  float(v(pw).decode().strip('"')),
                                                  float(v(tw).decode().strip('"')) + 273.15))
                for w in ("FL", "FR", "RL", "RR"):
                    bw = f"dynamic:BRAKE_WEAR.{w}"
                    if v(bw):
                        brake_wear_by_pad[w].append(float(v(bw).decode().strip('"')))
                if v("dynamic:VELOCITY") and v("dynamic:BRAKE_PEDAL_PCT"):
                    vel = float(v("dynamic:VELOCITY").decode().strip('"'))
                    brake_pct = float(v("dynamic:BRAKE_PEDAL_PCT").decode().strip('"'))
                    if prev_brake is not None and brake_pct > 5.0:
                        prev_t, prev_v = prev_brake
                        dt = t - prev_t  # real sample spacing (≈ simulator tick), NOT the poll interval
                        if dt > 0:
                            # Deceleration estimated from the actual velocity
                            # delta: a = Δv/Δt. Energy per simulator tick:
                            # m·a·v·Δt = m·|Δv|·v_avg (mass 1500 kg).
                            a = (vel - prev_v) / dt
                            v_avg = 0.5 * (vel + prev_v)
                            if a < -0.5 and v_avg > 0.5:
                                brake_energy += VEHICLE_MASS_KG * abs(a) * v_avg * dt
                    prev_brake = (t, vel)
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
        # Per-wheel tires: run detect_tires once per wheel. If the per-wheel
        # columns are absent (older sim / mixed history), fall back to the
        # single TIRE_PRESSURE channel on pm.{vin}.tires.
        wheel_tires = {w: s for w, s in tires_by_wheel.items() if s}
        if wheel_tires:
            for w, samples in wheel_tires.items():
                results[f"tires.{w}"] = detect_tires(samples, recommended_bar=2.3, wheel=w)
        elif tires:
            results["tires"] = detect_tires(tires)
        # Per-pad brakes: run detect_brake once per pad from the per-wheel
        # BRAKE_WEAR fraction the sim publishes. Missing BRAKE_WEAR.* columns
        # (older sim) keep the energy-accumulator path on pm.{vin}.brake.
        per_pad_wear = {w: vals[-1] for w, vals in brake_wear_by_pad.items() if vals}
        if per_pad_wear:
            for w, wear in per_pad_wear.items():
                results[f"brake.{w}"] = detect_brake(min(1.0, max(0.0, wear)), pad=w)
        elif brake_energy > 0:
            results["brake"] = detect_brake(min(1.0, brake_energy / BRAKE_ENERGY_BUDGET_J))  # E_budget 6 GJ
        if not self._nats.is_connected:
            try:
                await self._nats.connect()  # awaits the dial; no publish-before-connect race
            except Exception as e:
                logger.warning("NATS connect failed; skipping publish", vehicle_id=vin, error=repr(e))
                return
        if not self._nats.is_connected:
            logger.warning("NATS not connected; skipping publish", vehicle_id=vin)
            return
        try:
            for component, r in results.items():
                # Demo mode: publish the current state every poll for every
                # VIN (healthy included) so the /pm board always reflects live
                # health. (The spec's publish-on-change cadence kept the feed
                # quiet; the live board needs a state message per poll.)
                # Component keys are "battery", "tires.<wheel>", "brake.<pad>"
                # (and the legacy "tires"/"brake" fallbacks) — interpolating
                # them into the subject yields the 3-token pm.{vin}.{component}
                # or the 4-token pm.{vin}.{component}.{wheel} form.
                await self._nats.publish_message(
                    f"pm.{vin}.{component}",
                    PmMessage(vin=vin, component=component, health_score=r.health_score,
                              severity=r.severity, evidence=r.evidence,
                              explanation=r.explanation,
                              timestamp=datetime.now().isoformat()))
        except Exception as e:
            logger.error("Publish failed", vehicle_id=vin, error=repr(e))

    @staticmethod
    def _band_of(score: int) -> str:
        """Health-score band per spec §4: green ≥ 70, amber 50–69, red < 50."""
        if score >= 70:
            return "green"
        if score >= 50:
            return "amber"
        return "red"
