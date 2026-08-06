'use client';
import { useFrame } from '@react-three/fiber';
import { OrbitControls, useCursor } from '@react-three/drei';
import { useMemo, useRef, useState } from 'react';
import { BoxGeometry, DoubleSide, EdgesGeometry, type Group } from 'three';
import { SceneCanvasDynamic } from '@/components/scene/scene-canvas-dynamic';
import { useSceneMotion } from '@/components/scene/scene-canvas';
import { DemoPipeline } from '@/components/scene/demo-pipeline';
import { GridFloor } from '@/components/scene/grid-floor';
import { Starfield } from '@/components/scene/starfield';
import { VehicleModel } from '@/components/scene/vehicle-model';
import { COMPONENT_ZONES, type ComponentZone } from '@/lib/vehicle-components';

export interface DemoSceneProps {
  /** Active component id; its zone pulses and its pipeline hop highlights. */
  componentId: string;
  /** Called with the zone id when a zone box is clicked. */
  onSelect: (id: string) => void;
  /** True while telemetry is flowing (particles move, nodes bright). */
  flowing: boolean;
  /** Master switch for ambient animation (page-level reduced-motion). */
  animate: boolean;
  /** Vehicle identifier, surfaced in the scene's accessible label. */
  vin: string;
  /** Rendered in place of the canvas when WebGL is unavailable. */
  fallback?: React.ReactNode;
  className?: string;
}

/**
 * COMPONENT_ZONES positions/sizes are authored at unit scale, aligned with
 * the UNSCALED VehicleModel. The scene scales both by the same factor so the
 * zone regions keep hugging the car.
 */
const VEHICLE_SCALE = 1.8;
const VEHICLE_POSITION: [number, number, number] = [-4.5, 0, 1.5];

const IDLE_FILL_OPACITY = 0.12;
const ACTIVE_FILL_OPACITY = 0.35;
const IDLE_EDGE_OPACITY = 0.4;
const ACTIVE_EDGE_OPACITY = 0.95;

/**
 * One clickable component zone: translucent fill box + emissive wireframe
 * (EdgesGeometry). The active zone brightens and pulses while the scene
 * animates; hover shows the pointer cursor. Mirrors device-scene's ZoneBox —
 * kept local so the demo scene stands alone (vehicle + pipeline composition).
 *
 * Fill and edges render with depth testing off as a hologram overlay so the
 * zones stay visible from any camera angle; raycasting only tests objects
 * with handlers, so the car body never intercepts zone clicks.
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
 * Demo holographic scene: the vehicle (with clickable component zones) on
 * the left, the NATS→Bigtable data pipeline on the right, over a shared
 * starfield + grid floor. OrbitControls targets the pipeline's mid height
 * so both halves stay in frame. Renders inside SceneCanvasDynamic so the
 * WebGL probe never runs during SSR; `fallback` covers WebGL-less browsers.
 */
export function DemoScene({
  componentId,
  onSelect,
  flowing,
  animate,
  vin,
  fallback,
  className,
}: DemoSceneProps) {
  return (
    <SceneCanvasDynamic
      ariaLabel={`3D holographic demo scene for ${vin}: vehicle zones and telemetry pipeline`}
      animate={animate}
      fallback={fallback}
      className={className}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[6, 10, 4]} intensity={1.1} />
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        minDistance={4}
        maxDistance={18}
        target={[0, 1, 0]}
      />
      <GridFloor />
      <Starfield />
      {/* Vehicle left of the pipeline; zones scale with the car so the
          regions stay aligned with the body they describe. */}
      <group position={VEHICLE_POSITION} scale={VEHICLE_SCALE}>
        <VehicleModel color="#38bdf8" emissive="#38bdf8" pulse={flowing} />
        {COMPONENT_ZONES.map((zone) => (
          <ZoneBox key={zone.id} zone={zone} active={zone.id === componentId} onSelect={onSelect} />
        ))}
      </group>
      <DemoPipeline componentId={componentId} flowing={flowing} animate={animate} />
    </SceneCanvasDynamic>
  );
}

export default DemoScene;
