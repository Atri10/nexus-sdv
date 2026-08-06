'use client';
import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type { SceneCanvasProps } from '@/components/scene/scene-canvas';

export type { SceneCanvasProps } from '@/components/scene/scene-canvas';

/**
 * SceneCanvas loaded client-only (no SSR): three.js needs a DOM canvas and
 * the WebGL probe must not run during prerendering. Pages use this wrapper
 * instead of repeating the dynamic-import boilerplate.
 */
export const SceneCanvasDynamic = dynamic<SceneCanvasProps>(
  () => import('@/components/scene/scene-canvas'),
  { ssr: false },
);

/**
 * Type for a fallback component rendered in place of the scene when WebGL is
 * unsupported (e.g. a static schematic or a "3D unavailable" notice).
 */
export type SceneFallback = ComponentType<{ className?: string }>;
