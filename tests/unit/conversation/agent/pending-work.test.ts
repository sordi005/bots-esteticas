import { describe, expect, it } from 'vitest';
import { announcesPendingWork } from '../../../../src/modules/conversation/agent/pending-work.js';

describe('announcesPendingWork: anuncios que las evaluaciones mostraron (6.4)', () => {
  it.each([
    '¡Hola! Soy Luna, la asistente virtual de Estética Ejemplo. Dejame consultar los medios de pago para responderte.',
    '¡Hola! Soy Luna, la asistente virtual de Estética Ejemplo. Dejame buscar los precios de las uñas esculpidas.',
    'Hola, soy Luna, la asistente virtual de Estética Ejemplo. Dame un momento que busco tus turnos.',
    'Voy a buscar tu turno de mañana para cancelarlo.',
    'Listo, lo intento mover ahora',
    'Listo, voy a pasar tu turno al miércoles 14/10 a las 15:30 con Mica.',
    'Listo, el miércoles 14/10 a las 15:30 con Mica. Lo reviso y te confirmo enseguida.',
  ])('detecta: %s', (text) => {
    expect(announcesPendingWork(text)).toBe(true);
  });
});

describe('announcesPendingWork: respuestas normales', () => {
  it.each([
    '¿Querés que te busque otros horarios?',
    'Si querés, te paso con una persona del equipo.',
    'Decime qué día te queda mejor y te paso los horarios.',
    'El semi sale $18.000.',
    '¡Hola! Soy Luna, la asistente virtual de Estética Ejemplo. ¿En qué te puedo ayudar?',
  ])('no detecta: %s', (text) => {
    expect(announcesPendingWork(text)).toBe(false);
  });
});

describe('announcesPendingWork: otras formas del mismo anuncio', () => {
  it.each([
    'Déjame revisar la agenda.',
    'Dejame ver qué hay para el viernes.',
    'Dejame fijarme y te cuento.',
    'Dejame chequear los horarios.',
    'Dejame que consulte con la profesional.',
    'Voy a consultar los horarios libres.',
    'Voy a revisar tus turnos.',
    'Voy a fijarme si hay lugar.',
    'Voy a chequear la disponibilidad.',
    'Voy a ver qué tengo.',
    'Ya te busco los horarios.',
    'Ya consulto y te cuento.',
    'Ya reviso tus turnos.',
    'Ahora te busco otro horario.',
    'Enseguida me fijo.',
    'Estoy buscando tu turno.',
    'Un momento por favor.',
    'Un segundo, ya vuelvo.',
    'Un momentito.',
    'Esperame que veo.',
    'Esperame un cachito.',
    'Lo intento mover ahora.',
    'Intento moverlo ahora mismo.',
    'Lo voy a intentar.',
    'Voy a intentar reprogramarlo.',
    'Voy a cancelar tu turno de mañana.',
    'Voy a reprogramar el turno.',
  ])('detecta: %s', (text) => {
    expect(announcesPendingWork(text)).toBe(true);
  });

  it('no distingue mayúsculas ni tildes', () => {
    expect(announcesPendingWork('DEJAME CONSULTAR los medios de pago')).toBe(true);
    expect(announcesPendingWork('DÉJAME CONSULTAR los medios de pago')).toBe(true);
    expect(announcesPendingWork('un momentito, voy a fijarme')).toBe(true);
  });

  it('lo detecta aunque esté a mitad de un texto largo o con signos alrededor', () => {
    expect(announcesPendingWork('¡Hola, Ana! ¡Un momento...! Ya vuelvo con los precios.')).toBe(true);
  });
});

describe('announcesPendingWork: lo que parece un anuncio y no lo es', () => {
  it.each([
    'Si querés, te busco otros horarios.',
    '¿Querés que te consulte los medios de pago?',
    '¿Querés que lo intente mover a otro día?',
    'Para reservar voy a necesitar tu nombre.',
    // El texto de una derivación: corregirlo arriesgaría que el modelo la suelte.
    'Te voy a pasar con una persona del equipo, que te responde por acá en este horario.',
    'Listo, te pasé el turno al miércoles 14/10 a las 15:30 con Mica.',
    'Para cancelar voy a pedirte que confirmes con un botón.',
    'Si querés un segundo turno, decime qué día te queda bien.',
    'Hace un momento te mostré los horarios del viernes.',
    'Le paso tu consulta a una persona del equipo, que te va a responder en un momento.',
    'Podés dejarme tu nombre así te anoto.',
    'Ya veo, entonces preferís la tarde.',
    'Te paso con una persona del equipo, que te va a responder mañana a las 9.',
    'Tu turno quedó reservado para el viernes 9/10 a las 15:30.',
    'Cancelé tu turno del viernes.',
    'Lo que pasó es que no encontré ese horario.',
    'No lo pude mover: ese horario ya no está libre.',
    '',
  ])('no detecta: %s', (text) => {
    expect(announcesPendingWork(text)).toBe(false);
  });
});
