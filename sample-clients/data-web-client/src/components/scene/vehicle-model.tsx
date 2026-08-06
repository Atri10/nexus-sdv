'use client';
import { useFrame } from '@react-three/fiber';
import { Suspense, useMemo, useRef } from 'react';
import { Box3, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, Object3D, Vector3, type Mesh } from 'three';
import { useGLTF } from '@react-three/drei';
import { useSceneMotion } from '@/components/scene/scene-canvas';

export interface VehicleModelProps {
  /** Body paint color (recolors the model's paint material). */
  color?: string;
  /** Underglow + pulse-ring color. */
  emissive?: string;
  /** Oscillate the ground ring when animation is allowed. */
  pulse?: boolean;
  /** Uniform group scale (default 1). */
  scale?: number;
}

/**
 * Actual-3D-model vehicle: the classic Ferrari 458-style GLB shipped with
 * the three.js examples (MIT license, https://github.com/mrdoob/three.js),
 * normalized to the same footprint as the old procedural car so the
 * component zones in COMPONENT_ZONES keep hugging the body.
 */
const MODEL_URL = '/models/ferrari.glb';

/** Overall length the model is normalized to (matches the historical
 * procedural car so zones stay aligned). */
const CAR_LENGTH = 3.2;

// drei defaults the Draco decoder to a Google CDN; serve it from /draco so
// the scenes work offline. This module is SSR-evaluated (client components
// are prerendered), so guard the loader preflight with a window check.
if (typeof window !== 'undefined') {
  useGLTF.setDecoderPath('/draco/');
  useGLTF.preload(MODEL_URL);
}

/**
 * The loaded model, normalized once per color: scaled to CAR_LENGTH, sitting
 * on y = 0, centered in x/z. Materials are cloned so recoloring the paint
 * never leaks across VehicleModel instances (the fleet renders many cars).
 */
function FerrariBody({ color }: { color: string }) {
  const { scene } = useGLTF(MODEL_URL);
  const car = useMemo(() => {
    const clone = scene.clone(true) as Object3D;
    const box = new Box3().setFromObject(clone);
    const size = box.getSize(new Vector3());
    const s = CAR_LENGTH / size.z;
    clone.scale.setScalar(s);
    // The model's nose points -z; the demo scenes put the front at +z
    // (headlight-side toward the default camera), so flip it.
    clone.rotation.y = Math.PI;
    clone.updateMatrixWorld(true);

    const box2 = new Box3().setFromObject(clone);
    const center = box2.getCenter(new Vector3());
    clone.position.x -= center.x;
    clone.position.z -= center.z;
    clone.position.y -= box2.min.y;

    clone.traverse((o) => {
      const mesh = o as { isMesh?: boolean; material?: unknown };
      if (!mesh.isMesh || !mesh.material) return;
      const mat = mesh.material as MeshStandardMaterial;
      if (mat.name === 'Body_Color') {
        mat.color.set(color);
      }
    });
    return clone;
  }, [scene, color]);

  return <primitive object={car} />;
}

/**
 * Vehicle for the 3D scenes: a real car model (Ferrari GLB from the three.js
 * examples) with emissive underglow, headlight accent and an optional pulse
 * ring. The ring scales/opacity-oscillates in useFrame when `pulse` is set
 * and the scene allows animation; otherwise it sits static.
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
      {/* real car model (suspends while the GLB loads; preloaded eagerly) */}
      <Suspense fallback={null}>
        <FerrariBody color={color} />
      </Suspense>

      {/* underglow */}
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.5, 3.2]} />
        <meshBasicMaterial color={emissive} transparent opacity={0.35} />
      </mesh>

      {/* pulse ring */}
      <mesh ref={ring} position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.35, 1.5, 48]} />
        <meshBasicMaterial color={emissive} transparent opacity={0.25} side={DoubleSide} />
      </mesh>
    </group>
  );
}
