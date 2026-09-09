import React, { useState } from 'react';
import SettingsMenu from './SettingsMenu';
import { audioManager } from '@/lib/audioManager';

interface PauseMenuProps {
  open: boolean;
  onResume: () => void;
  onMenu: () => void;
}

export default function PauseMenu({ open, onResume, onMenu }: PauseMenuProps) {
  const [showSettings, setShowSettings] = useState(false);

  const handleResume = () => {
    audioManager.playSFX('attack');
    onResume();
  };

  const handleSettings = () => {
    audioManager.playSFX('powerup');
    setShowSettings(true);
  };

  const handleMenu = () => {
    audioManager.playSFX('attack');
    onMenu();
  };

  if (!open) return null;

  if (showSettings) {
    return (
      <SettingsMenu
        open={showSettings}
        onClose={() => setShowSettings(false)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur">
      <div className="w-full max-w-md space-y-6 rounded-lg bg-gradient-to-b from-slate-900 to-slate-950 p-8 text-center text-white shadow-2xl">
        {/* Pause Icon */}
        <div className="text-6xl">⏸️</div>

        {/* Title */}
        <div>
          <h1 className="text-4xl font-bold">PAUSADO</h1>
          <p className="mt-2 text-sm text-gray-400">Pressione ESC para continuar</p>
        </div>

        {/* Buttons */}
        <div className="space-y-3 pt-4">
          <button
            onClick={handleResume}
            className="w-full rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 py-4 font-bold text-white shadow-lg transition-all hover:from-blue-500 hover:to-blue-400 active:scale-95"
          >
            ▶️ Continuar
          </button>

          <button
            onClick={handleSettings}
            className="w-full rounded-lg bg-slate-700 py-3 font-semibold text-white transition-all hover:bg-slate-600 active:scale-95"
          >
            ⚙️ Configurações
          </button>

          <button
            onClick={handleMenu}
            className="w-full rounded-lg bg-red-700 py-3 font-semibold text-white transition-all hover:bg-red-600 active:scale-95"
          >
            🏠 Menu Principal
          </button>
        </div>

        {/* Info */}
        <div className="rounded bg-slate-800 p-3 text-xs text-gray-300">
          <div className="mb-2 font-bold">💡 Atalhos:</div>
          <div><strong>ESC</strong> - Pausar/Despausar</div>
          <div><strong>K/F</strong> - Chute especial</div>
        </div>
      </div>
    </div>
  );
}
