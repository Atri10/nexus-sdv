'use client';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useMemo, useRef, useState } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  QuadraticBezierCurve3,
  Vector3,
  type Curve,
} from 'three';
import { useSceneMotion } from '@/components/scene/scene-canvas';
import { DEMO_COMPONENTS } from '@/lib/vehicle-components';

export interface DemoPipelineProps {
  /** Active component id; its hop through the pipeline is highlighted. */
  componentId: string;
  /** True while telemetry is flowing: particles move and nodes brighten. */
  flowing: boolean;
  /** Master switch for animation (page-level reduced-motion). */
  animate: boolean;
}

/** Pipeline node positions in world space — a curved arc through the scene. */
const NODE_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1.2, -4], // Component
  [-3.5, 1.6, -2], // NATS
  [0, 2.0, 0], // Connector
  [3.5, 1.6, 2], // Bigtable
  [0, 1.2, 4], // Chart service
];

const NODE_LABELS = ['Component', 'NATS', 'Connector', 'Bigtable', 'Chart service'] as const;

/** Connections are the 4 hops between consecutive nodes. */
const SEGMENT_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
];

const NODE_CYAN = '#22d3ee';
const NODE_EMERALD = '#10b981';
const NODE_DIM = '#334155';
const TUBE_CYAN = '#22d3ee';
const TUBE_EMERALD = '#10b981';

/** Particles per hop; each covers the whole segment via its phase offset. */
const PARTICLES_PER_SEGMENT = 24;
/** Curve fraction traversed per second while flowing. */
const FLOW_SPEED = 0.16;
/** Frozen progress when animation is off (evenly spread static particles). */
const REST_PROGRESS = 0.5;

/**
 * Round additive sprite so particles read as glowing motes, not squares.
 * Built lazily in the canvas (client-only). Shared across every segment via
 * a module-level lazy singleton so the GPU upload happens exactly once.
 */
function makeDotTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 32, 32);
  }
  return new CanvasTexture(canvas);
}

let dotTexture: CanvasTexture | null = null;

/**
 * One point cloud per hop: `PARTICLES_PER_SEGMENT` particles with evenly
 * spaced phase offsets, so the whole stream translates along the curve as a
 * shared progress value advances. The advance is gated by `flowing && animate`
 * (plus the scene-wide reduced-motion flag); when idle the stream freezes at
 * REST_PROGRESS, leaving a static spread of dots along the hop.
 */
function ParticleStream({
  curve,
  active,
  flowing,
  live,
}: {
  curve: Curve<Vector3>;
  active: boolean;
  flowing: boolean;
  live: boolean;
}) {
  // BufferGeometry is mutated every frame, so the imperative path goes
  // through a ref; the same object is exposed to JSX via a lazy state init
  // (the react hooks compiler rejects both hook-value mutation and
  // render-time ref reads).
  const [geometry] = useState(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(PARTICLES_PER_SEGMENT * 3), 3));
    return g;
  });
  const geometryRef = useRef(geometry);
  const texture = useMemo(() => {
    dotTexture ??= makeDotTexture();
    return dotTexture;
  }, []);
  const progress = useRef(REST_PROGRESS);

  useFrame((_, delta) => {
    const frameGeometry = geometryRef.current;
    const positions = frameGeometry.attributes.position as BufferAttribute;
    const array = positions.array as Float32Array;
    if (live) {
      // Clamp the delta so a backgrounded tab cannot teleport the stream.
      progress.current = (progress.current + Math.min(delta, 0.05) * FLOW_SPEED) % 1;
    }
    for (let i = 0; i < PARTICLES_PER_SEGMENT; i += 1) {
      const point = curve.getPoint((progress.current + i / PARTICLES_PER_SEGMENT) % 1);
      array[i * 3] = point.x;
      array[i * 3 + 1] = point.y;
      array[i * 3 + 2] = point.z;
    }
    positions.needsUpdate = true;
  });

  return (
    <points geometry={geometry}>
      <pointsMaterial
        color={active ? NODE_EMERALD : NODE_CYAN}
        size={0.09}
        sizeAttenuation
        map={texture}
        transparent
        opacity={flowing ? 0.95 : 0.45}
        depthWrite={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}

/**
 * Holographic data-pipeline: 5 emissive nodes (Component → NATS → Connector →
 * Bigtable → Chart service) joined by QuadraticBezierCurve3 tubes with a
 * phase-offset particle stream per hop. The hop belonging to the selected
 * component's sensors (DEMO_COMPONENTS order maps onto hop 0–3) renders
 * brighter/emerald; nodes and particles dim when telemetry is idle.
 */
export function DemoPipeline({ componentId, flowing, animate }: DemoPipelineProps) {
  const { animate: motionAnimate } = useSceneMotion();
  // Particles move only while telemetry flows AND animation is allowed
  // (prop + scene-wide reduced-motion flag).
  const live = flowing && animate && motionAnimate;

  // Active hop: DEMO_COMPONENTS order (battery, powertrain, chassis, cabin)
  // maps 1:1 onto the 4 pipeline hops; unknown/'all' → no highlighted hop.
  const activeIndex = DEMO_COMPONENTS.findIndex((c) => c.id === componentId);

  const segments = useMemo(
    () =>
      SEGMENT_PAIRS.map(([from, to]) => {
        const a = new Vector3(...NODE_POSITIONS[from]);
        const b = new Vector3(...NODE_POSITIONS[to]);
        // Quadratic control point: midpoint lifted so the hop bows upward.
        const control = new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.55, (a.z + b.z) / 2);
        return new QuadraticBezierCurve3(a, control, b);
      }),
    [],
  );

  return (
    <group>
      {NODE_POSITIONS.map((position, i) => {
        // The source node of the active hop echoes its emerald highlight.
        const isHopSource = i === activeIndex;
        const color = !flowing ? NODE_DIM : isHopSource ? NODE_EMERALD : NODE_CYAN;
        return (
          <group key={NODE_LABELS[i]} position={position}>
            <mesh>
              <boxGeometry args={[0.5, 0.5, 0.5]} />
              <meshBasicMaterial color={color} transparent opacity={flowing ? 1 : 0.45} toneMapped={false} />
            </mesh>
            <Html position={[0, -0.6, 0]} center distanceFactor={10} style={{ pointerEvents: 'none' }}>
              <span
                className="whitespace-nowrap rounded border border-cyan-400/20 bg-slate-950/80 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-cyan-100"
                style={{ opacity: flowing ? 1 : 0.55 }}
              >
                {NODE_LABELS[i]}
              </span>
            </Html>
          </group>
        );
      })}

      {segments.map((curve, i) => {
        const active = i === activeIndex;
        return (
          <group key={i}>
            <mesh>
              <tubeGeometry args={[curve, 24, 0.03, 8, false]} />
              <meshBasicMaterial
                color={active ? TUBE_EMERALD : TUBE_CYAN}
                transparent
                opacity={active ? 0.95 : 0.5}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
            <ParticleStream curve={curve} active={active} flowing={flowing} live={live} />
          </group>
        );
      })}
    </group>
  );
}

export default DemoPipeline;
