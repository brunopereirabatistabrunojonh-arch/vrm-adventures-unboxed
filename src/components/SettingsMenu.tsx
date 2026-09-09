import React, { useState, useEffect } from 'react';
import { audioManager } from '@/lib/audioManager';

interface SettingsMenuProps {
  open: boolean;
  onClose: () => void;
}

export default function SettingsMenu({ open, onClose }: SettingsMenuProps) {
  const [masterVolume, setMasterVolume] = useState(0.7);
  const [musicVolume, setMusicVolume] = useState(0.5);
  const [sfxVolume, setSfxVolume] = useState(0.7);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [sensitivity, setSensitivity] = useState(50);
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('high');

  useEffect(() => {
    // Load saved settings
    const config = audioManager.getConfig();
    setMasterVolume(config.masterVolume);
    setMusicVolume(config.musicVolume);
    setSfxVolume(config.sfxVolume);
    setAudioEnabled(config.enabled);

    try {
      const sens = localStorage.getItem('bunny.sensitivity');
      if (sens) setSensitivity(parseInt(sens));
      const q = localStorage.getItem('bunny.quality');
      if (q === 'low' || q === 'medium' || q === 'high') setQuality(q);
    } catch {
      // Ignore
    }
  }, [open]);

  const handleMasterVolumeChange = (value: number) => {
    setMasterVolume(value);
    audioManager.setMasterVolume(value);
  };

  const handleMusicVolumeChange = (value: number) => {
    setMusicVolume(value);
    audioManager.setMusicVolume(value);
  };

  const handleSfxVolumeChange = (value: number) => {
    setSfxVolume(value);
    audioManager.setSFXVolume(value);
  };

  const handleAudioToggle = (enabled: boolean) => {
    setAudioEnabled(enabled);
    audioManager.setEnabled(enabled);
  };

  const handleSensitivityChange = (value: number) => {
    setSensitivity(value);
    try {
      localStorage.setItem('bunny.sensitivity', value.toString());
    } catch {
      // Ignore
    }
  };

  const handleQualityChange = (q: 'low' | 'medium' | 'high') => {
    setQuality(q);
    try {
      localStorage.setItem('bunny.quality', q);
    } catch {
      // Ignore
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur">
      <div className="w-full max-w-md rounded-lg bg-gradient-to-b from-slate-900 to-slate-950 p-6 text-white shadow-2xl">
        <h1 className="mb-6 text-3xl font-bold">⚙️ Configurações</h1>

        {/* Audio Section */}
        <div className="mb-6 space-y-4 border-b border-slate-700 pb-6">
          <h2 className="text-lg font-semibold">🔊 Áudio</h2>

          <div className="flex items-center justify-between">
            <label className="text-sm">Audio Ativado</label>
            <button
              onClick={() => handleAudioToggle(!audioEnabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                audioEnabled ? 'bg-green-500' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  audioEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {audioEnabled && (
            <>
              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <label>Volume Master</label>
                  <span className="text-yellow-400">{Math.round(masterVolume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={masterVolume * 100}
                  onChange={(e) => handleMasterVolumeChange(e.target.valueAsNumber / 100)}
                  className="w-full"
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <label>Volume Música</label>
                  <span className="text-blue-400">{Math.round(musicVolume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={musicVolume * 100}
                  onChange={(e) => handleMusicVolumeChange(e.target.valueAsNumber / 100)}
                  className="w-full"
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <label>Volume Efeitos</label>
                  <span className="text-purple-400">{Math.round(sfxVolume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={sfxVolume * 100}
                  onChange={(e) => handleSfxVolumeChange(e.target.valueAsNumber / 100)}
                  className="w-full"
                />
              </div>
            </>
          )}
        </div>

        {/* Game Section */}
        <div className="mb-6 space-y-4 border-b border-slate-700 pb-6">
          <h2 className="text-lg font-semibold">🎮 Jogo</h2>

          <div>
            <div className="mb-2 flex items-center justify-between text-xs">
              <label>Sensibilidade Camera</label>
              <span className="text-cyan-400">{sensitivity}%</span>
            </div>
            <input
              type="range"
              min="10"
              max="100"
              value={sensitivity}
              onChange={(e) => handleSensitivityChange(e.target.valueAsNumber)}
              className="w-full"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold">Qualidade Gráfica</label>
            <div className="flex gap-2">
              {(['low', 'medium', 'high'] as const).map((q) => (
                <button
                  key={q}
                  onClick={() => handleQualityChange(q)}
                  className={`flex-1 rounded py-2 text-xs font-bold transition-all ${
                    quality === q
                      ? 'bg-green-500 text-white'
                      : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  }`}
                >
                  {q === 'low' ? '🚀 Rápido' : q === 'medium' ? '⚖️ Médio' : '✨ Alto'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Controls Info */}
        <div className="mb-6 rounded bg-slate-800 p-3 text-xs">
          <h3 className="mb-2 font-semibold">⌨️ Controles</h3>
          <div className="space-y-1 text-gray-300">
            <div><strong>WASD</strong> - Mover</div>
            <div><strong>Shift</strong> - Correr</div>
            <div><strong>Space</strong> - Pular</div>
            <div><strong>Click</strong> - Atacar</div>
            <div><strong>K / F</strong> - Chute</div>
            <div><strong>Scroll</strong> - Zoom</div>
            <div><strong>Mouse</strong> - Câmera</div>
            <div><strong>ESC</strong> - Menu</div>
          </div>
        </div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="w-full rounded-lg bg-blue-600 py-3 font-bold text-white transition-all hover:bg-blue-500 active:scale-95"
        >
          ← Voltar
        </button>
      </div>
    </div>
  );
}
