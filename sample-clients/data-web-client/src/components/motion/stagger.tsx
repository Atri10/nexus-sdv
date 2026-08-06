'use client';

import type { ReactNode } from 'react';
import { motion, useReducedMotion, type Variants } from 'framer-motion';

/**
 * Stagger container: children (StaggerItem) rise in one after another, 60ms
 * apart, 200ms easeOut each. Reduced-motion users get a simultaneous
 * opacity-only fade (stagger 0, no y-offset).
 */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  const container: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduced ? 0 : 0.06 } },
  };
  return (
    <motion.div className={className} variants={container} initial="hidden" animate="show">
      {children}
    </motion.div>
  );
}

/** Single staggered child — fade + rise, animated when its Stagger ancestor plays. */
export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  const item: Variants = {
    hidden: { opacity: 0, y: reduced ? 0 : 8 },
    show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
  };
  return (
    <motion.div className={className} variants={item}>
      {children}
    </motion.div>
  );
}
