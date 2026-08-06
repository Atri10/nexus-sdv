'use client';

import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Entrance wrapper: fades in with a subtle 8px rise (200ms, easeOut, once on
 * mount). Reduced-motion users get an opacity-only fade — no transform.
 * Keep it dependency-light: no viewport triggers, no layout animations.
 */
export function FadeIn({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduced ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
