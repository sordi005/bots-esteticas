import { describe, expect, it } from 'vitest';
import { matchServices, normalizeText } from '../../../src/modules/catalog/service-search.js';

// El catálogo de "Estética Ejemplo" (src/seeds), en el orden en que lo lista el catálogo.
const CATALOG = [
  { name: 'Esmaltado semipermanente', aliases: ['semi', 'semipermanente', 'esmaltado'], category: 'Manos' },
  { name: 'Retiro de semipermanente', aliases: ['retiro', 'sacar el semi'], category: 'Manos' },
  { name: 'Uñas esculpidas', aliases: ['esculpidas', 'acrílicas', 'kapping'], category: 'Manos' },
  { name: 'Manos y pies semipermanente', aliases: ['manos y pies', 'combo'], category: 'Combos' },
  { name: 'Depilación láser', aliases: ['láser', 'depilación'], category: 'Depilación' },
  { name: 'Perfilado de cejas', aliases: ['cejas', 'perfilado'], category: 'Cejas' },
  { name: 'Lifting de pestañas', aliases: ['lifting', 'pestañas'], category: 'Pestañas' },
  { name: 'Semipermanente en pies', aliases: ['pies', 'semi en pies', 'pedicura'], category: 'Pies' },
];

const namesFor = (text: string) => matchServices(CATALOG, text).map((service) => service.name);

describe('normalizeText: compara sin tildes, mayúsculas ni signos', () => {
  it('saca tildes y pasa a minúsculas', () => {
    expect(normalizeText('Depilación LÁSER')).toBe('depilacion laser');
  });

  it('la ñ se compara como n: la gente escribe "unas" sin la tilde', () => {
    expect(normalizeText('Uñas')).toBe('unas');
    expect(normalizeText('unas')).toBe('unas');
  });

  it('cambia los signos por espacios y junta los espacios repetidos', () => {
    expect(normalizeText('  ¿Tienen   láser?! ')).toBe('tienen laser');
  });
});

describe('matchServices: busca en nombre y alias', () => {
  it('un alias exacto encuentra su servicio ("semi" es esmaltado semipermanente)', () => {
    expect(namesFor('semi')).toEqual(['Esmaltado semipermanente']);
  });

  it('no distingue mayúsculas ni tildes', () => {
    expect(namesFor('SEMI')).toEqual(['Esmaltado semipermanente']);
    expect(namesFor('Pestanas')).toEqual(['Lifting de pestañas']);
    expect(namesFor('depilacion')).toEqual(['Depilación láser']);
    expect(namesFor('acrilicas')).toEqual(['Uñas esculpidas']);
  });

  it('el nombre completo también es exacto, con o sin tildes', () => {
    expect(namesFor('Uñas esculpidas')).toEqual(['Uñas esculpidas']);
    expect(namesFor('unas esculpidas')).toEqual(['Uñas esculpidas']);
  });

  it('una coincidencia exacta gana sobre las parciales: "semi en pies" es el de pies', () => {
    expect(namesFor('semi en pies')).toEqual(['Semipermanente en pies']);
  });

  it('un alias de varias palabras es exacto ("sacar el semi" es el retiro)', () => {
    expect(namesFor('sacar el semi')).toEqual(['Retiro de semipermanente']);
  });

  it('si el texto contiene un nombre o alias completo, lo encuentra', () => {
    expect(namesFor('Hola! quiero hacerme las uñas esculpidas')).toEqual(['Uñas esculpidas']);
    expect(namesFor('¿Tienen láser?')).toEqual(['Depilación láser']);
  });

  it('con varias coincidencias parciales, primero la más específica', () => {
    // Contiene "semi" (esmaltado) y "sacar el semi" (retiro): la frase más larga va primero.
    expect(namesFor('quiero sacar el semi del mes pasado')).toEqual([
      'Retiro de semipermanente',
      'Esmaltado semipermanente',
    ]);
  });

  it('si un servicio cubre todas las palabras del texto, no devuelve los que solo coinciden en una', () => {
    // "semi" viene del alias "semi en pies" y "pies" del nombre; el esmaltado solo tiene "semi".
    expect(namesFor('semi pies')).toEqual(['Semipermanente en pies']);
    expect(namesFor('pies semi')).toEqual(['Semipermanente en pies']);
  });

  it('una palabra de la categoría trae todos los servicios que la usan, en el orden del catálogo', () => {
    expect(namesFor('manos')).toEqual([
      'Esmaltado semipermanente',
      'Retiro de semipermanente',
      'Uñas esculpidas',
      'Manos y pies semipermanente',
    ]);
  });

  it('ignora palabras de relleno como "con", "de" o "el" al juntar las palabras', () => {
    // Sin ignorar "con", el texto no se cubriría entero y devolvería también el esmaltado.
    expect(namesFor('semi con pies')).toEqual(['Semipermanente en pies']);
    expect(namesFor('lifting en pestañas')).toEqual(['Lifting de pestañas']);
  });

  it('si el texto cubre más que el servicio, igual lo encuentra por su nombre o alias', () => {
    expect(namesFor('cejas de mujer')).toEqual(['Perfilado de cejas']);
  });

  it('compara palabras enteras, no pedazos de palabras', () => {
    expect(namesFor('esmaltadora')).toEqual([]);
    expect(namesFor('semis')).toEqual([]);
  });

  it('si no está en el catálogo, no devuelve nada', () => {
    expect(namesFor('botox')).toEqual([]);
    expect(namesFor('masajes descontracturantes')).toEqual([]);
  });

  it('un texto vacío, de signos o solo de relleno no encuentra nada', () => {
    expect(namesFor('')).toEqual([]);
    expect(namesFor('   ')).toEqual([]);
    expect(namesFor('¿?!')).toEqual([]);
    expect(namesFor('de la')).toEqual([]);
  });

  it('un servicio sin alias se encuentra por el nombre', () => {
    const solo = [{ name: 'Masaje relajante', aliases: [] as string[], category: 'Cuerpo' }];
    expect(matchServices(solo, 'masaje')).toHaveLength(1);
    expect(matchServices(solo, 'relajante')).toHaveLength(1);
  });

  it('devuelve los mismos objetos que recibió, sin copiarlos', () => {
    const [match] = matchServices(CATALOG, 'cejas');
    expect(match).toBe(CATALOG[5]);
  });
});
