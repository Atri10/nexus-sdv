'use client';

/**
 * Ground plane for the 3D scene: a 40×40 helper grid slightly below the
 * origin plus a translucent circular pad under the vehicle.
 */
export function GridFloor() {
  return (
    <group>
      <gridHelper args={[40, 40, '#0f2740', '#123047']} position={[0, -0.05, 0]} />
      <mesh position={[0, -0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[4.5, 48]} />
        <meshBasicMaterial color="#123047" transparent opacity={0.35} />
      </mesh>
    </group>
  );
}
