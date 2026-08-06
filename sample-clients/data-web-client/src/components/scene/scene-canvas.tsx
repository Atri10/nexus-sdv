'use client';
import { Canvas } from '@react-three/fiber';
import { useReducedMotion } from 'framer-motion';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { webglSupported } from '@/lib/scene-coords';

export interface SceneCanvasProps {
  children: ReactNode;
  /** Rendered in place of the canvas when WebGL is unavailable. */
  fallback?: ReactNode;
  /** Accessible name for the scene (canvas wrapper has role="img"). */
  ariaLabel: string;
  /** Master switch for ambient animation; combined with reduced-motion. */
  animate?: boolean;
  className?: string;
}

export interface SceneMotionState {
  /** True when ambient animation is allowed (prop enabled and no reduced-motion). */
  animate: boolean;
}

/**
 * Ambient-motion flag for scene children (starfield rotation, pulse rings,
 * particle drift). Consumers read it with useSceneMotion().
 */
export const SceneMotionContext = createContext<SceneMotionState>({ animate: true });

export function useSceneMotion(): SceneMotionState {
  return useContext(SceneMotionContext);
}

const SCENE_BG = '#020617';

/**
 * Full-viewport three.js scene. Detects WebGL support and renders `fallback`
 * (or nothing) when unavailable; disables ambient animation under
 * prefers-reduced-motion. DPR is capped at 1.75 for GPU headroom.
 */
export function SceneCanvas({
  children,
  fallback,
  ariaLabel,
  animate = true,
  className,
}: SceneCanvasProps) {
  const supported = useMemo(() => webglSupported(), []);
  const reduced = useReducedMotion();
  const motionAllowed = animate && !reduced;

  if (!supported) return fallback ?? null;

  return (
    <SceneMotionContext.Provider value={{ animate: motionAllowed }}>
      <Canvas
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 50, position: [0, 6, 10] }}
        role="img"
        aria-label={ariaLabel}
        className={className}
      >
        <color attach="background" args={[SCENE_BG]} />
        <fog attach="fog" args={[SCENE_BG, 18, 40]} />
        {children}
      </Canvas>
    </SceneMotionContext.Provider>
  );
}

export default SceneCanvas;
