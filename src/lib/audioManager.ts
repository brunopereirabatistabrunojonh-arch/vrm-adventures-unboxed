/**
 * Audio Manager - Handles all game audio (BGM + SFX)
 * Uses Web Audio API for better control and spatial audio support
 */

export type SoundEffect = 
  | 'attack'
  | 'hit'
  | 'enemy_hit'
  | 'death'
  | 'enemy_spawn'
  | 'powerup'
  | 'level_up';

interface AudioConfig {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  enabled: boolean;
}

class AudioManager {
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  
  private bgmOscillator: OscillatorNode | null = null;
  private bgmGainNode: GainNode | null = null;
  private bgmPlaying = false;
  
  private config: AudioConfig = {
    masterVolume: 0.7,
    musicVolume: 0.5,
    sfxVolume: 0.7,
    enabled: true,
  };

  // Synth sounds generated procedurally
  private synths: Map<string, () => void> = new Map();

  constructor() {
    this.initAudioContext();
    this.setupSynths();
    this.loadConfig();
  }

  private initAudioContext() {
    if (typeof window === 'undefined') return;
    
    try {
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass();
      
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.config.masterVolume;
      this.masterGain.connect(this.audioContext.destination);
      
      this.musicGain = this.audioContext.createGain();
      this.musicGain.gain.value = this.config.musicVolume;
      this.musicGain.connect(this.masterGain);
      
      this.sfxGain = this.audioContext.createGain();
      this.sfxGain.gain.value = this.config.sfxVolume;
      this.sfxGain.connect(this.masterGain);
    } catch (e) {
      console.warn('[Audio] AudioContext not available:', e);
    }
  }

  private setupSynths() {
    // Attack sound - quick beep
    this.synths.set('attack', () => {
      if (!this.audioContext || !this.sfxGain) return;
      const now = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      
      osc.frequency.value = 400;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start(now);
      osc.stop(now + 0.1);
    });

    // Hit sound - impact beep
    this.synths.set('hit', () => {
      if (!this.audioContext || !this.sfxGain) return;
      const now = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(300, now + 0.15);
      osc.type = 'square';
      
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start(now);
      osc.stop(now + 0.15);
    });

    // Enemy hit - lower beep
    this.synths.set('enemy_hit', () => {
      if (!this.audioContext || !this.sfxGain) return;
      const now = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      
      osc.frequency.value = 200;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
      
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start(now);
      osc.stop(now + 0.12);
    });

    // Death sound - descending beep
    this.synths.set('death', () => {
      if (!this.audioContext || !this.sfxGain) return;
      const now = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(100, now + 0.5);
      osc.type = 'sine';
      
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start(now);
      osc.stop(now + 0.5);
    });

    // Enemy spawn - ascending beep
    this.synths.set('enemy_spawn', () => {
      if (!this.audioContext || !this.sfxGain) return;
      const now = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.2);
      osc.type = 'triangle';
      
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
      
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start(now);
      osc.stop(now + 0.2);
    });

    // Power up sound
    this.synths.set('powerup', () => {
      if (!this.audioContext || !this.sfxGain) return;
      const now = this.audioContext.currentTime;
      
      for (let i = 0; i < 3; i++) {
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.frequency.value = 400 + i * 200;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.15, now + i * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.1 + 0.15);
        
        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now + i * 0.1);
        osc.stop(now + i * 0.1 + 0.15);
      }
    });
  }

  playSFX(sound: SoundEffect) {
    if (!this.config.enabled) return;
    
    const synth = this.synths.get(sound);
    if (synth) {
      synth();
    }
  }

  startBGM() {
    if (!this.audioContext || !this.musicGain || this.bgmPlaying) return;
    
    const now = this.audioContext.currentTime;
    this.bgmOscillator = this.audioContext.createOscillator();
    this.bgmGainNode = this.audioContext.createGain();
    
    // Simple ambient tone (low frequency)
    this.bgmOscillator.frequency.value = 110; // A2
    this.bgmOscillator.type = 'sine';
    
    this.bgmGainNode.gain.setValueAtTime(0.1, now);
    
    this.bgmOscillator.connect(this.bgmGainNode);
    this.bgmGainNode.connect(this.musicGain);
    
    this.bgmOscillator.start(now);
    this.bgmPlaying = true;
  }

  stopBGM() {
    if (!this.bgmOscillator) return;
    
    const now = this.audioContext?.currentTime || 0;
    this.bgmGainNode?.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    this.bgmOscillator.stop(now + 0.5);
    
    this.bgmPlaying = false;
    this.bgmOscillator = null;
  }

  setMasterVolume(volume: number) {
    this.config.masterVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) {
      this.masterGain.gain.value = this.config.masterVolume;
    }
    this.saveConfig();
  }

  setMusicVolume(volume: number) {
    this.config.musicVolume = Math.max(0, Math.min(1, volume));
    if (this.musicGain) {
      this.musicGain.gain.value = this.config.musicVolume;
    }
    this.saveConfig();
  }

  setSFXVolume(volume: number) {
    this.config.sfxVolume = Math.max(0, Math.min(1, volume));
    if (this.sfxGain) {
      this.sfxGain.gain.value = this.config.sfxVolume;
    }
    this.saveConfig();
  }

  setEnabled(enabled: boolean) {
    this.config.enabled = enabled;
    if (!enabled) {
      this.stopBGM();
    }
    this.saveConfig();
  }

  getConfig() {
    return { ...this.config };
  }

  private saveConfig() {
    try {
      localStorage.setItem('audio.config', JSON.stringify(this.config));
    } catch {
      // Ignore storage errors
    }
  }

  private loadConfig() {
    try {
      const saved = localStorage.getItem('audio.config');
      if (saved) {
        this.config = { ...this.config, ...JSON.parse(saved) };
        if (this.masterGain) this.masterGain.gain.value = this.config.masterVolume;
        if (this.musicGain) this.musicGain.gain.value = this.config.musicVolume;
        if (this.sfxGain) this.sfxGain.gain.value = this.config.sfxVolume;
      }
    } catch {
      // Use defaults
    }
  }
}

// Singleton instance
export const audioManager = new AudioManager();
