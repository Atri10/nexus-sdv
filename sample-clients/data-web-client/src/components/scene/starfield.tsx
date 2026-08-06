'use client';
import { Stars } from '@react-three/drei';
import { useSceneMotion } from '@/components/scene/scene-canvas';

/**
 * Ambient starfield backdrop. Rotation is driven by drei's `speed` prop,
 * which is zeroed when the scene disables animation (reduced motion).
 */
export function Starfield() {
  const { animate } = useSceneMotion();
  return <Stars radius={60} depth={40} count={1500} factor={3} fade speed={animate ? 0.4 : 0} />;
}
