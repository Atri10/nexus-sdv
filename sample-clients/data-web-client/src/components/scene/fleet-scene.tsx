'use client';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Html, OrbitControls, useCursor } from '@react-three/drei';
import { SceneCanvasDynamic } from '@/components/scene/scene-canvas-dynamic';
import { useSceneMotion } from '@/components/scene/scene-canvas';
import { GridFloor } from '@/components/scene/grid-floor';
import { Starfield } from '@/components/scene/starfield';
import { VehicleModel } from '@/components/scene/vehicle-model';
import { projectLatLng } from '@/lib/scene-coords';
import { vinColorFamily } from '@/lib/telemetry-chart-utils';

export interface FleetVehicle {
  vin: string;
  lat?: number;
  lng?: number;
}

export interface FleetSceneProps {
  vehicles: FleetVehicle[];
  /**
   * VINs with fresh telemetry — they get an emerald pulse ring when the
   * scene animates. Defaults to empty; wiring live detection is deferred
   * (T9 polish), so vehicles render static until then.
   */
  liveVins?: Set<string>;
  /** Called with the VIN when a vehicle is clicked. */
  onSelect: (vin: string) => void;
  /** Called when empty space is clicked (deselect / clear highlight). */
  onDeselect?: () => void;
  /** Rendered in place of the canvas when WebGL is unavailable. */
  fallback?: ReactNode;
  className?: string;
}

/** Fallback origin when no vehicle carries GPS: Bengaluru demo coords. */
const DEFAULT_ORIGIN = { lat: 12.97, lng: 77.59 };

/** FNV-1a — stable per VIN, so scatter positions never shuffle between renders. */
function hashVin(vin: string): number {
  let h = 2166136261;
  for (let i = 0; i < vin.length; i += 1) {
    h ^= vin.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic ring position (radius 7–13) for vehicles without GPS. */
function scatterPosition(hash: number): { x: number; z: number } {
  const radius = 7 + ((hash % 1000) / 1000) * 6;
  const angle = ((hash >>> 8) % 6283) / 6283 * Math.PI * 2;
  return { x: radius * Math.cos(angle), z: radius * Math.sin(angle) };
}

interface PlacedVehicle {
  vehicle: FleetVehicle;
  position: { x: number; z: number };
}

const LIVE_EMISSIVE = '#22C55E';
const IDLE_EMISSIVE = '#0e7490';

/** Shared immutable default — avoids allocating a fresh Set on every render. */
const EMPTY_LIVE_VINS = new Set<string>();

/** One vehicle: body color from the vinColorFamily palette, hover cursor, click-to-select. */
function FleetVehicleNode({
  vehicle,
  position,
  live,
  showLabel,
  onSelect,
}: {
  vehicle: FleetVehicle;
  position: { x: number; z: number };
  live: boolean;
  showLabel: boolean;
  onSelect: (vin: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);
  const color = useMemo(() => vinColorFamily(hashVin(vehicle.vin), 0), [vehicle.vin]);

  return (
    <group
      position={[position.x, 0, position.z]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(vehicle.vin);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      <VehicleModel color={color} emissive={live ? LIVE_EMISSIVE : IDLE_EMISSIVE} pulse={live} />
      {showLabel && (
        <Html position={[0, 2.4, 0]} center distanceFactor={8} style={{ pointerEvents: 'auto' }}>
          <span
            className="whitespace-nowrap cursor-pointer rounded border border-cyan-400/20 bg-slate-950/80 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-cyan-100"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(vehicle.vin);
            }}
          >
            {vehicle.vin}
          </span>
        </Html>
      )}
    </group>
  );
}

/**
 * 3D fleet overview: every vehicle projected from GPS (origin = first GPS
 * vehicle, else Bengaluru), non-GPS vehicles scattered deterministically on a
 * ring. OrbitControls with damping; VIN labels when the fleet is small;
 * empty-space click deselects. Renders inside SceneCanvasDynamic so three.js
 * never runs during SSR and the `fallback` covers WebGL-less browsers.
 */
export function FleetScene({
  vehicles,
  liveVins = EMPTY_LIVE_VINS,
  onSelect,
  onDeselect,
  fallback,
  className,
}: FleetSceneProps) {
  const { animate } = useSceneMotion();
  const showLabels = vehicles.length <= 12;

  const placed = useMemo<PlacedVehicle[]>(() => {
    const gpsOrigin = vehicles.find((v) => v.lat != null && v.lng != null);
    const originLat = gpsOrigin?.lat ?? DEFAULT_ORIGIN.lat;
    const originLng = gpsOrigin?.lng ?? DEFAULT_ORIGIN.lng;
    return vehicles.map((vehicle) => ({
      vehicle,
      position:
        vehicle.lat != null && vehicle.lng != null
          ? projectLatLng(vehicle.lat, vehicle.lng, originLat, originLng)
          : scatterPosition(hashVin(vehicle.vin)),
    }));
  }, [vehicles]);

  return (
    <SceneCanvasDynamic ariaLabel="3D fleet scene" animate fallback={fallback} className={className}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[6, 10, 4]} intensity={1.1} />
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        minDistance={4}
        maxDistance={30}
        target={[0, 0, 0]}
        autoRotate={animate}
        autoRotateSpeed={0.4}
      />
      <GridFloor />
      <Starfield />
      {/* Invisible ground catcher: click on empty space deselects (clears highlight). */}
      <mesh
        position={[0, -0.045, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onDeselect?.();
        }}
      >
        <planeGeometry args={[100, 100]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {placed.map(({ vehicle, position }) => (
        <FleetVehicleNode
          key={vehicle.vin}
          vehicle={vehicle}
          position={position}
          live={liveVins.has(vehicle.vin)}
          showLabel={showLabels}
          onSelect={onSelect}
        />
      ))}
    </SceneCanvasDynamic>
  );
}

export default FleetScene;
