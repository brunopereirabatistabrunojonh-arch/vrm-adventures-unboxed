import React from 'react';
import { audioManager } from '@/lib/audioManager';

interface GameOverMenuProps {
  open: boolean;
  score: number;
  onRestart: () => void;
  onMenu: () => void;
}

export default function GameOverMenu({ open, score, onRestart, onMenu }: GameOverMenuProps) {
  const handleRestart = () => {
    audioManager.playSFX('powerup');
    onRestart();
  };

  const handleMenu = () => {
    audioManager.playSFX('attack');
    onMenu();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur">
      <div className="w-full max-w-md space-y-6 rounded-lg bg-gradient-to-b from-red-900 to-red-950 p-8 text-center text-white shadow-2xl">
        {/* Death Icon */}
        <div className="text-6xl">💀</div>

        {/* Title */}
        <div>
          <h1 className="text-4xl font-bold text-red-300">GAME OVER</h1>
          <p className="mt-2 text-sm text-red-200">Você foi derrotado...</p>
        </div>

        {/* Score Display */}
        <div className="rounded-lg bg-black/50 py-6">
          <div className="text-sm text-gray-300">Pontuação Final</div>
          <div className="text-5xl font-bold text-yellow-400">{score}</div>
          <div className="mt-2 text-xs text-gray-400">
            {score === 0 && '😅 Melhor sorte na próxima!'}
            {score > 0 && score <= 5 && '👍 Não foi ruim!'}
            {score > 5 && score <= 15 && '🔥 Bom desempenho!'}
            {score > 15 && '⭐ IMPRESSIONANTE!'}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded bg-slate-800 p-3">
            <div className="text-gray-400">Inimigos Derrotados</div>
            <div className="text-lg font-bold text-cyan-400">{score}</div>
          </div>
          <div className="rounded bg-slate-800 p-3">
            <div className="text-gray-400">Tentativas</div>
            <div className="text-lg font-bold text-orange-400">1</div>
          </div>
        </div>

        {/* Buttons */}
        <div className="space-y-3 pt-4">
          <button
            onClick={handleRestart}
            className="w-full rounded-lg bg-gradient-to-r from-green-600 to-green-500 py-4 font-bold text-white shadow-lg transition-all hover:from-green-500 hover:to-green-400 active:scale-95"
          >
            🔄 Jogar Novamente
          </button>

          <button
            onClick={handleMenu}
            className="w-full rounded-lg bg-slate-700 py-3 font-semibold text-white transition-all hover:bg-slate-600 active:scale-95"
          >
            ← Menu Principal
          </button>
        </div>

        {/* Tip */}
        <div className="rounded border border-blue-500/50 bg-blue-500/10 p-3 text-xs text-blue-200">
          <strong>💡 Dica:</strong> Mantenha a distância e use o Chute (K/F) para dano extra!
        </div>
      </div>
    </div>
  );
}
