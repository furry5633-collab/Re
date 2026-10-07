// Skins (apariencia) disponibles para los personajes.
const SKINS = [
  { id: 'plata',  label: 'Plata',  color: '#e6ecff', accent: '#8ea2ff', ink: '#1b2140' },
  { id: 'rosa',   label: 'Rosa',   color: '#ffd6ea', accent: '#ff6fb1', ink: '#4a1030' },
  { id: 'azul',   label: 'Azul',   color: '#c8ecff', accent: '#2f8fe0', ink: '#052a4a' },
  { id: 'morado', label: 'Morado', color: '#e4d2ff', accent: '#8a4fe0', ink: '#2c0d55' },
  { id: 'verde',  label: 'Verde',  color: '#d4f5d8', accent: '#2fb35a', ink: '#0c3a1a' },
  { id: 'dorado', label: 'Dorado', color: '#fff1bf', accent: '#e0a420', ink: '#4a3300' },
];

const isValidSkin = (id) => SKINS.some((s) => s.id === id);

module.exports = { SKINS, isValidSkin };
