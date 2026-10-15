import { describe, expect, it } from 'vitest';
import { claimsAppointmentChange } from '../../../../src/modules/conversation/agent/claimed-change.js';

describe('claimsAppointmentChange: el texto afirma que un turno cambió (6.4)', () => {
  it.each([
    // Lo que mostraron las evaluaciones.
    'Listo, lo paso al miércoles 14/10 a las 15:30 con Mica. Ya te quedó reprogramado.',
    // «quedó» + el estado
    'Tu turno quedó reservado para el viernes 16/10 a las 16:00.',
    'El turno quedó reprogramado para el miércoles.',
    'Tu turno quedó cancelado y el horario se liberó.',
    'Ya te quedó reprogramado.',
    'Ya te quedó cancelado, no hace falta que hagas nada más.',
    'Te quedó reservado el turno del viernes.',
    'Quedaron reservados los dos turnos.',
    'Tu turno quedó para el viernes 16/10 a las 16:00.',
    'Ya te quedó el turno para el jueves.',
    // Primera persona en pasado
    '¡Listo! Te lo reservé para el viernes 16/10.',
    'Ya lo reservé.',
    'Cancelé tu turno del viernes.',
    'Listo, ya te cancelé el turno.',
    'Te pasé el turno al miércoles 14/10 a las 15:30 con Mica.',
    'Ya lo pasé al miércoles.',
    'Reprogramé tu turno para el jueves.',
    'Ya moví tu turno al jueves a las 10:00.',
    'Te anoté para el viernes a las 16:00.',
    'Te agendé para el martes.',
    // Presente de «pasar» con el destino: es una acción hecha en el mismo texto
    'Perfecto, lo paso al viernes a las 16:00.',
    // Confirmaciones sueltas
    'Listo, reprogramado.',
    'Perfecto, reservado para el viernes.',
    'Anotado.',
    '¡Agendado! Te esperamos el viernes.',
    'Listo, ya cancelado.',
    // Una afirmación seguida de una pregunta
    'Ya te lo reservé, ¿necesitás algo más?',
    'Ya te quedó reprogramado. ¿Algo más en lo que te ayude?',
  ])('detecta: %s', (text) => {
    expect(claimsAppointmentChange(text)).toBe(true);
  });

  it('no distingue mayúsculas', () => {
    expect(claimsAppointmentChange('YA TE QUEDÓ REPROGRAMADO')).toBe(true);
  });
});

describe('claimsAppointmentChange: preguntas y ofertas', () => {
  it.each([
    '¿Te lo reservo?',
    '¿Lo paso a ese horario?',
    '¿Confirmás que lo cancelamos?',
    'Si querés te lo reservo.',
    'Si querés, lo paso al jueves.',
    'Si querés, te lo reservo para el viernes a las 16:00.',
    '¿Querés que te lo reserve para el viernes?',
    '¿Querés que lo cancele?',
    'Puedo reprogramarlo al jueves si te sirve.',
    '¿Querés que quede reservado para el viernes?',
    'Cuando elijas un horario te lo reservo.',
    'Tocá el horario que te quede mejor para dejarlo reservado.',
    'Para que quede reservado necesito tu nombre.',
  ])('no detecta: %s', (text) => {
    expect(claimsAppointmentChange(text)).toBe(false);
  });
});

describe('claimsAppointmentChange: negaciones', () => {
  it.each([
    'No se canceló nada.',
    'Todavía no quedó reservado: tocá el horario para confirmarlo.',
    'No te lo reservé todavía.',
    'Tu turno sigue como estaba.',
    'El turno sigue donde estaba, no se movió.',
    'No pude reprogramarlo: ese horario ya no está libre.',
    'Todavía no cancelé nada, ¿querés que lo cancele?',
    'No quedó reprogramado, el horario se ocupó.',
  ])('no detecta: %s', (text) => {
    expect(claimsAppointmentChange(text)).toBe(false);
  });

  it('una negación de otra parte de la frase no anula la afirmación', () => {
    expect(claimsAppointmentChange('No hay problema, ya te quedó reservado.')).toBe(true);
    expect(claimsAppointmentChange('Ya te lo reservé, no te preocupes.')).toBe(true);
  });
});

describe('claimsAppointmentChange: descripciones de un turno que ya existía', () => {
  it.each([
    'Tenés un turno el viernes 16/10 a las 16:00.',
    'Tenés un turno reservado para el viernes 16/10 a las 16:00 con Mica.',
    'Tu turno de semipermanente es el viernes 16/10 a las 16:00 y está confirmado.',
    'Tenés dos turnos: uno cancelado el lunes y uno reservado el viernes.',
    'Tu turno del lunes está cancelado.',
    'El turno figura anotado para el viernes.',
    // El turno que se cayó solo por la seña: es una explicación, no un cambio de esta vuelta.
    'Tu turno quedó cancelado porque no se pagó la seña a tiempo.',
    'Tu turno se canceló porque venció el plazo de la seña.',
    'Si no pagás la seña hasta el jueves, el horario se libera.',
    'Para cancelar sin cargo tenés que avisar con 48 horas de anticipación.',
    'Podés reprogramar el turno hasta 24 horas antes.',
    'Los turnos se reservan con una seña del 30%.',
    'Ya hay un turno reservado en ese horario.',
    '',
    'El semi sale $18.000.',
    '¡Hola! Soy Luna. ¿En qué te ayudo?',
  ])('no detecta: %s', (text) => {
    expect(claimsAppointmentChange(text)).toBe(false);
  });
});

describe('claimsAppointmentChange: la forma del texto', () => {
  it.each([
    ['en una línea aparte', 'Hola, Ana.\nTe lo reservé para el viernes.'],
    ['con una oferta a continuación', 'Ya te quedó reprogramado, si querés lo cambiamos a otro día.'],
    ['con signos y emojis alrededor', '¡¡Listo!! 💅 Reprogramado para el miércoles 14/10.'],
    ['con las tildes descompuestas', 'Te lo reservé para el viernes.'],
    ['a mitad de un texto largo', 'Gracias por esperar, Ana. Cancelé tu turno del lunes y el horario se liberó.'],
  ])('detecta %s', (_name, text) => {
    expect(claimsAppointmentChange(text)).toBe(true);
  });

  it.each([
    ['la afirmación está dentro de una pregunta con dos frases', 'Hola. ¿Querés que te lo reserve? ¿O preferís otro día?'],
    ['el subjuntivo sin tilde del hecho', 'Necesito que lo cancele una persona del equipo.'],
  ])('no detecta %s', (_name, text) => {
    expect(claimsAppointmentChange(text)).toBe(false);
  });
});
