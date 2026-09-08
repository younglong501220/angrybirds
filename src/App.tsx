import React, { useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import { Volume2, VolumeX, RotateCcw, Download, Sparkles, FastForward, ArrowLeft } from 'lucide-react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

interface TrailPoint {
  x: number;
  y: number;
  alpha: number;
}

interface CustomPigBody extends Matter.Body {
  health: number;
  radius: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [score, setScore] = useState<number>(0);
  const [birdsLeft, setBirdsLeft] = useState<number>(3);
  const [gameState, setGameState] = useState<'playing' | 'won' | 'lost'>('playing');
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [birdFiredState, setBirdFiredState] = useState<boolean>(false);

  // Audio Context ref
  const audioCtxRef = useRef<AudioContext | null>(null);
  const isMutedRef = useRef<boolean>(false);
  isMutedRef.current = isMuted;

  // Sound function
  const playSound = (type: 'launch' | 'hit' | 'pop') => {
    if (isMutedRef.current) return;
    try {
      if (!audioCtxRef.current) {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new AudioContextClass();
      }
      const audioCtx = audioCtxRef.current;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const t = audioCtx.currentTime;

      if (type === 'launch') {
        osc.frequency.setValueAtTime(320, t);
        osc.frequency.exponentialRampToValueAtTime(750, t + 0.16);
        gain.gain.setValueAtTime(0.35, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.22);
        osc.start(t);
        osc.stop(t + 0.22);
      } else if (type === 'hit') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(160, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
        gain.gain.setValueAtTime(0.4, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
        osc.start(t);
        osc.stop(t + 0.1);
      } else if (type === 'pop') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, t);
        osc.frequency.exponentialRampToValueAtTime(1200, t + 0.1);
        gain.gain.setValueAtTime(0.4, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
        osc.start(t);
        osc.stop(t + 0.15);
      }
    } catch {
      // Audio context might fail before first gesture
    }
  };

  // Game internal state references
  const gameRef = useRef<{
    engine: Matter.Engine;
    bird: Matter.Body | null;
    pigs: CustomPigBody[];
    blocks: Matter.Body[];
    particles: Particle[];
    flightTrail: TrailPoint[];
    birdsLeft: number;
    score: number;
    isDragging: boolean;
    birdFired: boolean;
    canInteract: boolean;
    dragPos: { x: number; y: number };
    waitInterval: NodeJS.Timeout | null;
    animId: number | null;
    spawnNextBird: () => void;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { Engine, Bodies, Body, Composite, Events } = Matter;

    const engine = Engine.create({
      gravity: { x: 0, y: 1.1 },
    });
    const world = engine.world;

    const SLING_POS = { x: 180, y: 390 };
    const MAX_DRAG = 90;
    const LAUNCH_POWER = 0.22;

    // Ground and boundary walls
    const ground = Bodies.rectangle(480, 520, 960, 40, { isStatic: true, label: 'ground' });
    const leftWall = Bodies.rectangle(-10, 270, 20, 540, { isStatic: true });
    const rightWall = Bodies.rectangle(970, 270, 20, 540, { isStatic: true });
    Composite.add(world, [ground, leftWall, rightWall]);

    const game = {
      engine,
      bird: null as Matter.Body | null,
      pigs: [] as CustomPigBody[],
      blocks: [] as Matter.Body[],
      particles: [] as Particle[],
      flightTrail: [] as TrailPoint[],
      birdsLeft: 3,
      score: 0,
      isDragging: false,
      birdFired: false,
      canInteract: true,
      dragPos: { ...SLING_POS },
      waitInterval: null as NodeJS.Timeout | null,
      animId: null as number | null,
      spawnNextBird: () => {},
    };
    gameRef.current = game;

    const createBlock = (x: number, y: number, w: number, h: number) => {
      return Bodies.rectangle(x, y, w, h, {
        restitution: 0.1,
        friction: 0.8,
        density: 0.002,
        label: 'wood',
      });
    };

    const createPig = (x: number, y: number, r: number): CustomPigBody => {
      const pig = Bodies.circle(x, y, r, {
        restitution: 0.3,
        friction: 0.5,
        density: 0.001,
        label: 'pig',
      }) as CustomPigBody;
      pig.health = 100;
      pig.radius = r;
      return pig;
    };

    const spawnBird = () => {
      if (game.birdsLeft <= 0) {
        if (game.pigs.length > 0) {
          setGameState('lost');
        }
        return;
      }
      if (game.waitInterval) clearInterval(game.waitInterval);
      if (game.bird) Composite.remove(world, game.bird);

      game.birdFired = false;
      setBirdFiredState(false);
      game.canInteract = true;
      game.dragPos = { ...SLING_POS };
      game.flightTrail = [];

      // CRITICAL FIX: Create without isStatic: true, then call Body.setStatic(bird, true)
      // so Matter.js saves part._original and correctly restores mass on Body.setStatic(bird, false)!
      const bird = Bodies.circle(SLING_POS.x, SLING_POS.y, 16, {
        label: 'bird',
        density: 0.005,
        restitution: 0.5,
      });
      Body.setStatic(bird, true);
      game.bird = bird;
      Composite.add(world, bird);
    };
    game.spawnNextBird = spawnBird;

    const popPig = (pigBody: CustomPigBody) => {
      const index = game.pigs.indexOf(pigBody);
      if (index !== -1) {
        game.pigs.splice(index, 1);
        Composite.remove(world, pigBody);
        playSound('pop');
        game.score += 1000;
        setScore(game.score);

        // Explosion particles
        for (let i = 0; i < 18; i++) {
          game.particles.push({
            x: pigBody.position.x,
            y: pigBody.position.y,
            vx: (Math.random() - 0.5) * 9,
            vy: (Math.random() - 0.5) * 9,
            life: 1,
            color: Math.random() > 0.5 ? '#7ad335' : '#ffffff',
            size: Math.random() * 5 + 3,
          });
        }

        if (game.pigs.length === 0) {
          setGameState('won');
        }
      }
    };

    const setupLevel = () => {
      if (game.waitInterval) clearInterval(game.waitInterval);
      if (game.bird) Composite.remove(world, game.bird);
      game.pigs.forEach((p) => Composite.remove(world, p));
      game.blocks.forEach((b) => Composite.remove(world, b));
      game.pigs = [];
      game.blocks = [];
      game.particles = [];
      game.flightTrail = [];

      const baseX = 700;

      // Lower columns & beam
      game.blocks.push(createBlock(baseX - 60, 460, 18, 80));
      game.blocks.push(createBlock(baseX + 60, 460, 18, 80));
      game.blocks.push(createBlock(baseX, 410, 160, 16));
      game.pigs.push(createPig(baseX, 470, 18));

      // 2nd layer columns & beam
      game.blocks.push(createBlock(baseX - 45, 360, 16, 80));
      game.blocks.push(createBlock(baseX + 45, 360, 16, 80));
      game.blocks.push(createBlock(baseX, 310, 120, 16));
      game.pigs.push(createPig(baseX, 375, 16));

      // Top pig
      game.pigs.push(createPig(baseX, 280, 14));

      Composite.add(world, [...game.blocks, ...game.pigs]);
      spawnBird();
    };

    // Collision detection
    const handleCollision = (event: Matter.IEventCollision<Matter.Engine>) => {
      event.pairs.forEach((pair) => {
        const { bodyA, bodyB } = pair;
        const checkPig = (pigBody: Matter.Body, other: Matter.Body) => {
          if (pigBody.label === 'pig') {
            const speed = Body.getSpeed(other);
            if (speed > 1.8) {
              const customPig = pigBody as CustomPigBody;
              customPig.health -= speed * 25;
              playSound('hit');
              if (customPig.health <= 0) {
                popPig(customPig);
              }
            }
          }
        };
        checkPig(bodyA, bodyB);
        checkPig(bodyB, bodyA);
      });
    };

    Events.on(engine, 'collisionStart', handleCollision);

    // Coordinate helper supporting mouse and touch events
    const getPos = (e: MouseEvent | TouchEvent) => {
      const rect = canvas.getBoundingClientRect();
      let clientX = 0;
      let clientY = 0;
      if ('touches' in e && e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if ('changedTouches' in e && e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
      } else {
        clientX = (e as MouseEvent).clientX;
        clientY = (e as MouseEvent).clientY;
      }
      return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!game.canInteract || game.birdFired || !game.bird) return;
      const pos = getPos(e);
      const distToSling = Math.hypot(pos.x - SLING_POS.x, pos.y - SLING_POS.y);
      const distToBird = Math.hypot(pos.x - game.bird.position.x, pos.y - game.bird.position.y);
      if (distToSling < 65 || distToBird < 65) {
        game.isDragging = true;
      }
    };

    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!game.isDragging || !game.bird) return;
      const pos = getPos(e);
      const dx = pos.x - SLING_POS.x;
      const dy = pos.y - SLING_POS.y;
      const dist = Math.hypot(dx, dy);

      if (dist > MAX_DRAG) {
        const angle = Math.atan2(dy, dx);
        game.dragPos.x = SLING_POS.x + Math.cos(angle) * MAX_DRAG;
        game.dragPos.y = SLING_POS.y + Math.sin(angle) * MAX_DRAG;
      } else {
        game.dragPos.x = pos.x;
        game.dragPos.y = pos.y;
      }
      Body.setPosition(game.bird, game.dragPos);
    };

    const onUp = () => {
      if (!game.isDragging || !game.bird) return;
      game.isDragging = false;

      const dx = SLING_POS.x - game.dragPos.x;
      const dy = SLING_POS.y - game.dragPos.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 8) {
        game.birdFired = true;
        setBirdFiredState(true);
        game.canInteract = false;

        // Position bird exactly at release point
        Body.setPosition(game.bird, game.dragPos);
        
        // Restore dynamic physics (Body.setStatic false safely works now!)
        Body.setStatic(game.bird, false);
        Body.setVelocity(game.bird, {
          x: dx * LAUNCH_POWER,
          y: dy * LAUNCH_POWER,
        });

        playSound('launch');
        game.birdsLeft--;
        setBirdsLeft(game.birdsLeft);

        // Smart advancement: advance to next bird when stopped or after 4 seconds
        if (game.waitInterval) clearInterval(game.waitInterval);
        let ticks = 0;
        game.waitInterval = setInterval(() => {
          ticks++;
          if (!game.bird) {
            if (game.waitInterval) clearInterval(game.waitInterval);
            return;
          }
          const speed = Body.getSpeed(game.bird);
          const pos = game.bird.position;
          const hasLanded = pos.y > 480 && speed < 0.6;
          const isOffscreen = pos.x > 980 || pos.x < -30;
          const isStopped = speed < 0.25 && ticks > 8;

          if (hasLanded || isOffscreen || isStopped || ticks >= 38) {
            if (game.waitInterval) clearInterval(game.waitInterval);
            if (game.pigs.length > 0) {
              if (game.birdsLeft > 0) {
                spawnBird();
              } else {
                setGameState('lost');
              }
            }
          }
        }, 100);
      } else {
        // Drag was too small, snap bird back to slingshot center
        game.dragPos = { ...SLING_POS };
        Body.setPosition(game.bird, game.dragPos);
      }
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    const onTouchDown = (e: TouchEvent) => {
      onDown(e);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (game.isDragging) {
        e.preventDefault();
      }
      onMove(e);
    };

    canvas.addEventListener('touchstart', onTouchDown, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onUp);

    // Render helpers
    const drawSlingshotBack = () => {
      ctx.fillStyle = '#613812';
      ctx.fillRect(SLING_POS.x - 6, SLING_POS.y, 12, 110);
    };

    const drawSlingshotFront = () => {
      ctx.strokeStyle = '#8B4513';
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(SLING_POS.x, SLING_POS.y + 15);
      ctx.lineTo(SLING_POS.x - 14, SLING_POS.y - 12);
      ctx.moveTo(SLING_POS.x, SLING_POS.y + 15);
      ctx.lineTo(SLING_POS.x + 14, SLING_POS.y - 12);
      ctx.stroke();
    };

    const drawTrajectory = () => {
      const vx = (SLING_POS.x - game.dragPos.x) * LAUNCH_POWER;
      const vy = (SLING_POS.y - game.dragPos.y) * LAUNCH_POWER;
      let simX = game.dragPos.x;
      let simY = game.dragPos.y;
      let simVy = vy;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      for (let i = 0; i < 28; i++) {
        simX += vx * 1.5;
        simY += simVy * 1.5;
        simVy += engine.gravity.y * 1.1;

        if (i % 2 === 0) {
          const radius = Math.max(2, 4.5 - i * 0.1);
          ctx.beginPath();
          ctx.arc(simX, simY, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const drawBird = (b: Matter.Body) => {
      if (isNaN(b.position.x) || isNaN(b.position.y)) return;
      ctx.save();
      ctx.translate(b.position.x, b.position.y);
      ctx.rotate(b.angle);

      // Red round body
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.fill();

      // White belly
      ctx.fillStyle = '#fce4ec';
      ctx.beginPath();
      ctx.arc(-2, 5, 8, 0, Math.PI);
      ctx.fill();

      // Eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(6, -3, 4.5, 0, Math.PI * 2);
      ctx.arc(12, -3, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Pupils
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(7.5, -3, 2, 0, Math.PI * 2);
      ctx.arc(13.5, -3, 2, 0, Math.PI * 2);
      ctx.fill();

      // Angry eyebrows
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(3, -9);
      ctx.lineTo(16, -6);
      ctx.stroke();

      // Yellow beak
      ctx.fillStyle = '#f39c12';
      ctx.beginPath();
      ctx.moveTo(8, -1);
      ctx.lineTo(18, 2);
      ctx.lineTo(8, 5);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    };

    const drawSmallBird = (x: number, y: number) => {
      ctx.save();
      ctx.translate(x, y);

      // Red round body
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();

      // Belly
      ctx.fillStyle = '#fce4ec';
      ctx.beginPath();
      ctx.arc(-1, 3, 6, 0, Math.PI);
      ctx.fill();

      // Eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(4, -2, 3.5, 0, Math.PI * 2);
      ctx.arc(8, -2, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(5, -2, 1.5, 0, Math.PI * 2);
      ctx.arc(9, -2, 1.5, 0, Math.PI * 2);
      ctx.fill();

      // Beak
      ctx.fillStyle = '#f39c12';
      ctx.beginPath();
      ctx.moveTo(6, -0.5);
      ctx.lineTo(13, 1.5);
      ctx.lineTo(6, 3.5);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    };

    const drawPig = (p: CustomPigBody) => {
      if (isNaN(p.position.x) || isNaN(p.position.y)) return;
      ctx.save();
      ctx.translate(p.position.x, p.position.y);
      ctx.rotate(p.angle);
      const r = p.radius;

      // Green body
      ctx.fillStyle = '#66cc33';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      // Pig snout
      ctx.fillStyle = '#4da32a';
      ctx.beginPath();
      ctx.ellipse(0, 2, r * 0.45, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();

      // Nostrils
      ctx.fillStyle = '#225511';
      ctx.beginPath();
      ctx.arc(-r * 0.18, 2, r * 0.1, 0, Math.PI * 2);
      ctx.arc(r * 0.18, 2, r * 0.1, 0, Math.PI * 2);
      ctx.fill();

      // Big eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(-r * 0.4, -r * 0.3, r * 0.28, 0, Math.PI * 2);
      ctx.arc(r * 0.4, -r * 0.3, r * 0.28, 0, Math.PI * 2);
      ctx.fill();

      // Pupils
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(-r * 0.35, -r * 0.3, r * 0.1, 0, Math.PI * 2);
      ctx.arc(r * 0.35, -r * 0.3, r * 0.1, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    };

    const drawWoodBlock = (b: Matter.Body) => {
      if (isNaN(b.position.x) || isNaN(b.position.y)) return;
      ctx.save();
      ctx.translate(b.position.x, b.position.y);
      ctx.rotate(b.angle);
      const w = b.bounds.max.x - b.bounds.min.x;
      const h = b.bounds.max.y - b.bounds.min.y;

      ctx.fillStyle = '#b87333';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = '#6e3c15';
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    };

    // Main animation loop
    let tickCount = 0;
    const render = () => {
      tickCount++;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 1. Clouds in the sky
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      [150, 450, 750].forEach((cx, i) => {
        ctx.beginPath();
        ctx.arc(cx, 80 + i * 15, 30, 0, Math.PI * 2);
        ctx.arc(cx + 25, 75 + i * 15, 35, 0, Math.PI * 2);
        ctx.arc(cx + 50, 80 + i * 15, 28, 0, Math.PI * 2);
        ctx.fill();
      });

      // 2. Slingshot back pillar
      drawSlingshotBack();

      // 3. Trajectory dots while pulling
      if (game.isDragging) {
        drawTrajectory();
      }

      // 4. Slingshot back band
      if (game.bird && (game.isDragging || !game.birdFired)) {
        ctx.strokeStyle = '#301708';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(SLING_POS.x - 12, SLING_POS.y - 10);
        ctx.lineTo(game.bird.position.x, game.bird.position.y);
        ctx.stroke();
      }

      // 5. Draw Bird
      if (game.bird) {
        drawBird(game.bird);
      }

      // 6. Slingshot front band & front pillar
      if (game.bird && (game.isDragging || !game.birdFired)) {
        ctx.strokeStyle = '#301708';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(game.bird.position.x, game.bird.position.y);
        ctx.lineTo(SLING_POS.x + 12, SLING_POS.y - 10);
        ctx.stroke();
      } else if (!game.isDragging && (!game.bird || game.birdFired)) {
        // Resting elastic band between prongs
        ctx.strokeStyle = '#301708';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(SLING_POS.x - 12, SLING_POS.y - 10);
        ctx.lineTo(SLING_POS.x + 12, SLING_POS.y - 10);
        ctx.stroke();
      }
      drawSlingshotFront();

      // 7. Spare birds waiting in queue on the grass
      const spareCount = game.birdFired ? game.birdsLeft : game.birdsLeft - 1;
      for (let i = 0; i < spareCount; i++) {
        drawSmallBird(110 - i * 32, 492);
      }

      // 8. Flight smoke trail behind bird
      if (game.birdFired && game.bird && !isNaN(game.bird.position.x)) {
        if (tickCount % 2 === 0) {
          game.flightTrail.push({
            x: game.bird.position.x,
            y: game.bird.position.y,
            alpha: 1.0,
          });
        }
      }
      game.flightTrail.forEach((pt) => {
        ctx.fillStyle = `rgba(255, 255, 255, ${pt.alpha * 0.7})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        pt.alpha -= 0.006;
      });
      game.flightTrail = game.flightTrail.filter((pt) => pt.alpha > 0.05);

      // 9. Wood castle blocks
      game.blocks.forEach(drawWoodBlock);

      // 10. Green Pigs
      game.pigs.forEach(drawPig);

      // 11. Explosion particles
      game.particles.forEach((p, idx) => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.03;
        if (p.life <= 0) {
          game.particles.splice(idx, 1);
        } else {
          ctx.fillStyle = p.color;
          ctx.globalAlpha = p.life;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      });

      // 12. Friendly pull guide hint if ready to fire
      if (!game.birdFired && !game.isDragging && game.birdsLeft > 0) {
        const pulse = (Math.sin(tickCount * 0.08) + 1) * 0.5;
        ctx.save();
        ctx.fillStyle = `rgba(255, 255, 255, ${0.4 + pulse * 0.5})`;
        ctx.font = 'bold 15px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('◄ 往後拉動小鳥發射', SLING_POS.x - 30 - pulse * 8, SLING_POS.y - 30);
        ctx.restore();
      }

      Engine.update(engine, 1000 / 60);
      game.animId = requestAnimationFrame(render);
    };

    setupLevel();
    game.animId = requestAnimationFrame(render);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') {
        handleReset();
      } else if (e.key === ' ' || e.key === 'Enter') {
        if (game.birdFired && game.birdsLeft > 0) {
          spawnBird();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      Events.off(engine, 'collisionStart', handleCollision);
      if (game.animId) cancelAnimationFrame(game.animId);
      if (game.waitInterval) clearInterval(game.waitInterval);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('touchstart', onTouchDown);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('keydown', onKeyDown);
      Engine.clear(engine);
    };
  }, []);

  const handleReset = () => {
    setGameState('playing');
    setScore(0);
    setBirdsLeft(3);
    setBirdFiredState(false);

    const game = gameRef.current;
    if (!game) return;

    const { Composite, Bodies, Body } = Matter;
    const world = game.engine.world;
    const SLING_POS = { x: 180, y: 390 };

    game.score = 0;
    game.birdsLeft = 3;
    game.isDragging = false;
    game.birdFired = false;
    game.canInteract = true;
    game.flightTrail = [];
    if (game.waitInterval) clearInterval(game.waitInterval);

    if (game.bird) Composite.remove(world, game.bird);
    game.pigs.forEach((p) => Composite.remove(world, p));
    game.blocks.forEach((b) => Composite.remove(world, b));
    game.pigs = [];
    game.blocks = [];
    game.particles = [];

    const createBlock = (x: number, y: number, w: number, h: number) => {
      return Bodies.rectangle(x, y, w, h, {
        restitution: 0.1,
        friction: 0.8,
        density: 0.002,
        label: 'wood',
      });
    };

    const createPig = (x: number, y: number, r: number): CustomPigBody => {
      const pig = Bodies.circle(x, y, r, {
        restitution: 0.3,
        friction: 0.5,
        density: 0.001,
        label: 'pig',
      }) as CustomPigBody;
      pig.health = 100;
      pig.radius = r;
      return pig;
    };

    const baseX = 700;
    game.blocks.push(createBlock(baseX - 60, 460, 18, 80));
    game.blocks.push(createBlock(baseX + 60, 460, 18, 80));
    game.blocks.push(createBlock(baseX, 410, 160, 16));
    game.pigs.push(createPig(baseX, 470, 18));

    game.blocks.push(createBlock(baseX - 45, 360, 16, 80));
    game.blocks.push(createBlock(baseX + 45, 360, 16, 80));
    game.blocks.push(createBlock(baseX, 310, 120, 16));
    game.pigs.push(createPig(baseX, 375, 16));

    game.pigs.push(createPig(baseX, 280, 14));

    Composite.add(world, [...game.blocks, ...game.pigs]);

    game.dragPos = { ...SLING_POS };
    const bird = Bodies.circle(SLING_POS.x, SLING_POS.y, 16, {
      label: 'bird',
      density: 0.005,
      restitution: 0.5,
    });
    Body.setStatic(bird, true);
    game.bird = bird;
    Composite.add(world, bird);
  };

  const handleNextBirdNow = () => {
    if (gameRef.current && gameRef.current.birdsLeft > 0) {
      gameRef.current.spawnNextBird();
    }
  };

  return (
    <div className="w-screen min-h-screen bg-[#1e293b] flex flex-col items-center justify-center p-2 sm:p-4 text-slate-100 select-none font-sans overflow-x-hidden">
      {/* Top Header Controls Bar */}
      <header className="w-full max-w-[960px] flex items-center justify-between py-2 px-3 mb-2 bg-slate-800/80 backdrop-blur rounded-xl border border-slate-700/60 shadow-md">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center shadow-inner border border-red-400 font-bold text-sm">
            鳥
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-bold tracking-tight text-white flex items-center gap-1.5">
              憤怒鳥 Angry Birds 經典版
            </h1>
            <p className="text-xs text-slate-400 hidden sm:block">
              HTML5 Canvas + Matter.js 物理引擎彈弓拋射
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Sound Toggle */}
          <button
            id="sound-toggle-btn"
            onClick={() => setIsMuted((m) => !m)}
            className="p-2 text-slate-300 hover:text-white bg-slate-700/70 hover:bg-slate-700 rounded-lg transition-colors border border-slate-600/60 text-xs flex items-center gap-1.5 cursor-pointer"
            title={isMuted ? '開啟音效' : '靜音'}
          >
            {isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
            <span className="hidden md:inline">{isMuted ? '靜音中' : '音效'}</span>
          </button>

          {/* Download standalone HTML */}
          <a
            id="download-html-link"
            href="./angry_birds.html"
            download="angry_birds.html"
            className="px-2.5 py-1.5 text-xs text-amber-200 hover:text-amber-100 bg-amber-900/40 hover:bg-amber-800/60 rounded-lg transition-colors border border-amber-600/50 flex items-center gap-1.5"
            title="下載獨立單一 HTML 檔案"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">下載 HTML</span>
          </a>

          {/* Reset button */}
          <button
            id="btn-header-reset"
            onClick={handleReset}
            className="px-3 py-1.5 text-xs sm:text-sm font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg shadow transition-transform active:scale-95 flex items-center gap-1.5 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>重新開始</span>
          </button>
        </div>
      </header>

      {/* Main Game Stage Container */}
      <main
        ref={containerRef}
        id="game-container"
        className="relative w-full max-w-[960px] aspect-[16/9] rounded-2xl overflow-hidden shadow-2xl border border-slate-700/80 bg-slate-900 flex items-center justify-center touch-none"
      >
        {/* In-Game HUD overlay */}
        <div id="ui" className="absolute top-3 left-4 right-4 flex items-center justify-between pointer-events-none z-10">
          <div className="flex items-center gap-3 sm:gap-4">
            <div
              id="score-text"
              className="text-white text-sm sm:text-xl font-black drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full border border-white/10 flex items-center gap-1.5"
            >
              <Sparkles className="w-4 h-4 text-yellow-300" />
              <span>分數: {score}</span>
            </div>
            <div
              id="birds-text"
              className="text-white text-sm sm:text-xl font-black drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full border border-white/10 flex items-center gap-1.5"
            >
              <span className="inline-block w-3.5 h-3.5 rounded-full bg-red-500 border border-white/40" />
              <span>剩餘小鳥: {birdsLeft}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 pointer-events-auto">
            {birdFiredState && birdsLeft > 0 && gameState === 'playing' && (
              <button
                id="btn-next-bird"
                onClick={handleNextBirdNow}
                className="bg-sky-600 hover:bg-sky-500 text-white text-xs sm:text-sm font-bold px-3 py-1.5 rounded-full shadow-[0_3px_#0369a1] active:translate-y-1 active:shadow-none transition-all cursor-pointer flex items-center gap-1"
                title="立即裝填下一隻小鳥"
              >
                <FastForward className="w-3.5 h-3.5" />
                <span>下一隻</span>
              </button>
            )}
            <button
              id="btn-reset"
              onClick={handleReset}
              className="bg-[#f39c12] hover:bg-[#e67e22] text-white text-xs sm:text-base font-bold px-3 sm:px-4 py-1.5 rounded-full shadow-[0_4px_#d68910] active:translate-y-1 active:shadow-none transition-all cursor-pointer"
            >
              重新開始
            </button>
          </div>
        </div>

        {/* Win/Lose Overlay */}
        {gameState !== 'playing' && (
          <div
            id="overlay"
            className="absolute inset-0 bg-black/75 backdrop-blur-sm flex flex-col justify-center items-center text-white z-20 transition-all p-4 text-center"
          >
            <h2
              id="overlay-title"
              className={`text-3xl sm:text-5xl font-black mb-4 drop-shadow-[0_4px_8px_rgba(0,0,0,0.9)] ${
                gameState === 'won' ? 'text-yellow-400' : 'text-red-400'
              }`}
            >
              {gameState === 'won' ? '🎉 擊敗小豬！通關成功！' : '💥 小鳥用盡，再接再厲！'}
            </h2>
            <p className="text-slate-300 text-sm sm:text-base mb-6 max-w-md">
              {gameState === 'won'
                ? `太神了！消滅了所有小豬，最終獲得 ${score} 分！`
                : '發射力道與角度是關鍵，試著朝木架的下層支柱撞擊！'}
            </p>
            <button
              id="overlay-restart-btn"
              onClick={handleReset}
              className="bg-[#2ecc71] hover:bg-[#27ae60] text-white text-lg sm:text-2xl font-bold px-8 py-3 rounded-full shadow-[0_5px_#1e8449] active:translate-y-1 active:shadow-none transition-all cursor-pointer"
            >
              再來一局
            </button>
          </div>
        )}

        {/* Game Canvas */}
        <canvas
          id="canvas"
          ref={canvasRef}
          width={960}
          height={540}
          className="w-full h-full block cursor-grab active:cursor-grabbing touch-none"
          style={{
            background: 'linear-gradient(to bottom, #87CEEB 0%, #E0F6FF 70%, #85d05d 70%, #4da32a 100%)',
          }}
        />
      </main>

      {/* Control Tips & Guidance */}
      <footer className="w-full max-w-[960px] mt-2.5 px-3 py-2 bg-slate-800/40 rounded-xl border border-slate-700/40 flex flex-wrap items-center justify-between text-xs text-slate-400 gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-slate-300 font-semibold">發射操作:</span>
          <span>1. 滑鼠按住彈弓上的紅鳥向左後方拖曳</span>
          <span>2. 依照白色拋物點虛線掌握預測航道</span>
          <span>3. 放開滑鼠小鳥立即破空射出！</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded text-slate-300 font-mono text-[10px] border border-slate-600">
              R
            </kbd>
            <span>重置</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded text-slate-300 font-mono text-[10px] border border-slate-600">
              Space
            </kbd>
            <span>裝填下一隻</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
