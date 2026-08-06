'use client';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { DoubleSide, MeshBasicMaterial, type Mesh } from 'three';
import { useSceneMotion } from '@/components/scene/scene-canvas';

export interface VehicleModelProps {
  /** Body paint color. */
  color?: string;
  /** Underglow + headlight + pulse-ring color. */
  emissive?: string;
  /** Oscillate the ground ring when animation is allowed. */
  pulse?: boolean;
  /** Uniform group scale (default 1). */
  scale?: number;
}

const WHEEL_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [-0.85, 0.28, 1.15],
  [0.85, 0.28, 1.15],
  [-0.85, 0.28, -1.15],
  [0.85, 0.28, -1.15],
];

/**
 * Procedural vehicle for the 3D scene: box body, dark-glass cabin, four
 * side-mounted cylinder wheels, emissive underglow plane, two headlights and
 * an optional pulse ring. The ring scales/opacity-oscillates in useFrame when
 * `pulse` is set and the scene allows animation; otherwise it sits static.
 */
export function VehicleModel({ color = '#3b82f6', emissive = '#38bdf8', pulse = false, scale = 1 }: VehicleModelProps) {
  const { animate } = useSceneMotion();
  const ring = useRef<Mesh>(null);
  const live = pulse && animate;

  useFrame(({ clock }) => {
    const ringMesh = ring.current;
    if (!ringMesh) return;
    const material = ringMesh.material;
    // The ring is always created with a single meshBasicMaterial below.
    if (!(material instanceof MeshBasicMaterial)) return;

    if (!live) {
      ringMesh.scale.setScalar(1);
      material.opacity = 0.25;
      return;
    }

    const t = clock.getElapsedTime();
    const k = 1 + 0.35 * Math.sin(t * 2.4);
    ringMesh.scale.setScalar(k);
    material.opacity = 0.45 * (1 - (k - 1) / 0.35);
  });

  return (
    <group scale={scale}>
      {/* body */}
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[1.6, 0.5, 3.2]} />
        <meshStandardMaterial color={color} metalness={0.6} roughness={0.3} />
      </mesh>

      {/* cabin — dark glass */}
      <mesh position={[0, 0.95, -0.2]}>
        <boxGeometry args={[1.1, 0.45, 1.6]} />
        <meshStandardMaterial color="#0b1220" metalness={0.9} roughness={0.1} />
      </mesh>

      {/* wheels — cylinders rotated onto their sides */}
      {WHEEL_POSITIONS.map((pos, i) => (
        <mesh key={i} position={[...pos]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.28, 0.28, 0.2, 20]} />
          <meshStandardMaterial color="#111827" roughness={0.9} />
        </mesh>
      ))}

      {/* underglow */}
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.7, 3.3]} />
        <meshBasicMaterial color={emissive} transparent opacity={0.35} />
      </mesh>

      {/* headlights */}
      <mesh position={[-0.5, 0.5, 1.62]}>
        <boxGeometry args={[0.3, 0.14, 0.05]} />
        <meshBasicMaterial color={emissive} />
      </mesh>
      <mesh position={[0.5, 0.5, 1.62]}>
        <boxGeometry args={[0.3, 0.14, 0.05]} />
        <meshBasicMaterial color={emissive} />
      </mesh>

      {/* pulse ring */}
      <mesh ref={ring} position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.35, 1.5, 48]} />
        <meshBasicMaterial color={emissive} transparent opacity={0.25} side={DoubleSide} />
      </mesh>
    </group>
  );
}
