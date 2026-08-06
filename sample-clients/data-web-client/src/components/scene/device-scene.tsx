'use client';
import { useFrame } from '@react-three/fiber';
import { OrbitControls, useCursor } from '@react-three/drei';
import { useMemo, useRef, useState } from 'react';
import { BoxGeometry, DoubleSide, EdgesGeometry, type Group } from 'three';
import { SceneCanvasDynamic } from '@/components/scene/scene-canvas-dynamic';
import { useSceneMotion } from '@/components/scene/scene-canvas';
import { GridFloor } from '@/components/scene/grid-floor';
import { Starfield } from '@/components/scene/starfield';
import { VehicleModel } from '@/components/scene/vehicle-model';
import { COMPONENT_ZONES, type ComponentZone } from '@/lib/vehicle-components';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

export interface DeviceSceneProps {
  /** Active component id ('all' means no zone highlighted). */
  componentId: string;
  /** Called with the zone id when a zone box is clicked. */
  onSelect: (id: string) => void;
  /** Body paint color; defaults to the shell primary cyan. */
  color?: string;
  /** Master switch for the active-zone pulse; default true. */
  animate?: boolean;
  /**
   * Series for the vehicle — reserved for downstream consumers (T5 demo
   * scene, T6 unit-aware axes). The scene itself renders from COMPONENT_ZONES.
   */
  series?: ChartSeries[];
}

/**
 * COMPONENT_ZONES positions/sizes are authored at unit scale, aligned with
 * the UNSCALED VehicleModel. The scene scales both by the same factor so the
 * zone regions keep hugging the car.
 */
const VEHICLE_SCALE = 1.6;

const IDLE_FILL_OPACITY = 0.12;
const ACTIVE_FILL_OPACITY = 0.35;
const IDLE_EDGE_OPACITY = 0.4;
const ACTIVE_EDGE_OPACITY = 0.95;

/**
 * One clickable component zone: translucent fill box + emissive wireframe
 * (EdgesGeometry). The active zone brightens and pulses (scale 1 → 1.06)
 * while the scene animates; hover shows the pointer cursor.
 *
 * The fill and edges render with depth testing off as a hologram overlay:
 * the zone regions are authored to hug the car body, so normal depth
 * testing would hide them behind the body/glass from most camera angles.
 * Raycasting is unaffected — R3F only tests objects with handlers, so the
 * car body never intercepts zone clicks.
 */
function ZoneBox({
  zone,
  active,
  onSelect,
}: {
  zone: ComponentZone;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const { animate } = useSceneMotion();
  const group = useRef<Group>(null);
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);

  // Shared geometry so the fill box and its edge wireframe never diverge.
  const geometry = useMemo(() => new BoxGeometry(...zone.size), [zone]);
  const edges = useMemo(() => new EdgesGeometry(geometry), [geometry]);

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    if (!active || !animate) {
      g.scale.setScalar(1);
      return;
    }
    const t = clock.getElapsedTime();
    // Smooth 1 → 1.06 pulse (0.5 + 0.5·sin ∈ [0, 1]).
    g.scale.setScalar(1 + 0.06 * (0.5 + 0.5 * Math.sin(t * 3)));
  });

  return (
    <group
      ref={group}
      position={zone.position}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(zone.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      <mesh geometry={geometry} renderOrder={1}>
        <meshBasicMaterial
          color={zone.color}
          transparent
          opacity={active ? ACTIVE_FILL_OPACITY : IDLE_FILL_OPACITY}
          side={DoubleSide}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={edges} renderOrder={2}>
        <lineBasicMaterial
          color={zone.color}
          transparent
          opacity={active ? ACTIVE_EDGE_OPACITY : IDLE_EDGE_OPACITY}
          toneMapped={false}
          depthTest={false}
          depthWrite={false}
        />
      </lineSegments>
    </group>
  );
}

/**
 * Single-vehicle 3D scene: the procedural car at the origin with four
 * translucent component zones (battery, powertrain, chassis, cabin) rendered
 * from the shared COMPONENT_ZONES metadata. The active zone brightens and
 * pulses; zones are clickable (hover cursor) and report through onSelect.
 * Renders inside SceneCanvasDynamic so the WebGL probe never runs during SSR;
 * when WebGL is unavailable the canvas is skipped entirely (the page keeps
 * its chart and table).
 */
export function DeviceScene({
  componentId,
  onSelect,
  color = '#38bdf8',
  animate = true,
}: DeviceSceneProps) {
  return (
    <SceneCanvasDynamic ariaLabel="3D vehicle scene with component zones" animate={animate} className="h-full w-full">
      <ambientLight intensity={0.5} />
      <directionalLight position={[6, 10, 4]} intensity={1.1} />
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        minDistance={3}
        maxDistance={12}
        target={[0, 0.5, 0]}
      />
      <GridFloor />
      <Starfield />
      <VehicleModel color={color} emissive={color} scale={VEHICLE_SCALE} />
      {/* Zones are authored at unit scale; scale them with the car so the
          regions stay aligned with the body they describe. */}
      <group scale={VEHICLE_SCALE}>
        {COMPONENT_ZONES.map((zone) => (
          <ZoneBox key={zone.id} zone={zone} active={zone.id === componentId} onSelect={onSelect} />
        ))}
      </group>
    </SceneCanvasDynamic>
  );
}

export default DeviceScene;
