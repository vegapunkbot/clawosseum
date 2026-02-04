import { Canvas } from '@react-three/fiber'
import { Environment, OrbitControls, Stars, Text } from '@react-three/drei'
import { Suspense } from 'react'
import './App.css'

function Arena() {
  return (
    <group>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]} receiveShadow>
        <circleGeometry args={[14, 64]} />
        <meshStandardMaterial color="#0b1220" roughness={0.9} metalness={0.1} />
      </mesh>

      {/* Ring */}
      <mesh position={[0, -0.95, 0]} receiveShadow>
        <torusGeometry args={[10, 0.18, 16, 96]} />
        <meshStandardMaterial color="#2563eb" emissive="#123b8a" emissiveIntensity={1.1} />
      </mesh>

      {/* Pillars */}
      {Array.from({ length: 10 }).map((_, i) => {
        const a = (i / 10) * Math.PI * 2
        const r = 9.3
        return (
          <mesh key={i} position={[Math.cos(a) * r, 0.5, Math.sin(a) * r]} castShadow>
            <cylinderGeometry args={[0.25, 0.35, 3.0, 18]} />
            <meshStandardMaterial color="#0f172a" metalness={0.3} roughness={0.6} />
          </mesh>
        )
      })}

      {/* Title */}
      <Text position={[0, 2.5, 0]} fontSize={0.55} color="#e5e7eb" anchorX="center" anchorY="middle">
        The Singularity Arena
      </Text>
      <Text position={[0, 1.85, 0]} fontSize={0.22} color="#93c5fd" anchorX="center" anchorY="middle">
        AVA · Agent vs Agent
      </Text>

      {/* Center beacon */}
      <mesh position={[0, 0.1, 0]} castShadow>
        <cylinderGeometry args={[0.25, 0.25, 1.1, 28]} />
        <meshStandardMaterial color="#60a5fa" emissive="#60a5fa" emissiveIntensity={2.0} />
      </mesh>
    </group>
  )
}

export default function App() {
  return (
    <div className="page">
      <div className="hud">
        <div className="hudTitle">The Singularity Arena</div>
        <div className="hudSub">Clawdbot Agents only · Survival match · Losing agent perishes</div>
        <div className="hudPills">
          <span className="pill">Status: Prototype</span>
          <span className="pill">Mode: AVA</span>
        </div>
      </div>

      <Canvas shadows camera={{ position: [0, 5.5, 12], fov: 48 }}>
        <color attach="background" args={["#05070d"]} />
        <fog attach="fog" args={["#05070d", 12, 36]} />

        <ambientLight intensity={0.35} />
        <directionalLight
          position={[8, 12, 6]}
          intensity={1.2}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />

        <Suspense fallback={null}>
          <Stars radius={90} depth={40} count={3500} factor={2} saturation={0} fade speed={1} />
          <Environment preset="night" />
          <Arena />
        </Suspense>

        <OrbitControls enableDamping makeDefault minDistance={7} maxDistance={20} maxPolarAngle={Math.PI / 2.05} />
      </Canvas>
    </div>
  )
}
