import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSystemPrompt, type PromptTenant } from '../../../../src/modules/conversation/agent/system-prompt.js';
import { agentTools } from '../../../../src/modules/conversation/tools/index.js';

const example: PromptTenant = { name: 'Estética Ejemplo', assistantName: 'Luna', emojiUsage: 'low', usesVoseo: true };

describe('buildSystemPrompt: se arma por negocio desde la configuración (8.5)', () => {
  it('nombra al negocio y al asistente', () => {
    const prompt = buildSystemPrompt(example);

    expect(prompt).toContain('Luna');
    expect(prompt).toContain('Estética Ejemplo');
    expect(buildSystemPrompt({ ...example, name: 'Centro Aura', assistantName: 'Sol' })).toMatch(/Sol.*Centro Aura/s);
  });

  it('es idéntico entre llamadas del mismo negocio, para que el proveedor reutilice la caché', () => {
    expect(buildSystemPrompt(example)).toBe(buildSystemPrompt({ ...example }));
  });

  it('no lleva fechas, horas ni datos de la clienta: eso va en el contexto de la vuelta', () => {
    const prompt = buildSystemPrompt(example);

    expect(prompt).not.toMatch(/\d{1,2}\/\d{1,2}\/?\d{0,4}/);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prompt).not.toMatch(/\d{1,2}:\d{2}/);
    expect(prompt).not.toMatch(/20\d{2}/);
  });

  it('cambia con el uso de emojis', () => {
    const none = buildSystemPrompt({ ...example, emojiUsage: 'none' });
    const low = buildSystemPrompt({ ...example, emojiUsage: 'low' });
    const medium = buildSystemPrompt({ ...example, emojiUsage: 'medium' });

    expect(new Set([none, low, medium]).size).toBe(3);
    expect(none).toMatch(/no uses emojis/i);
  });

  it('cambia con el voseo', () => {
    const voseo = buildSystemPrompt({ ...example, usesVoseo: true });
    const tuteo = buildSystemPrompt({ ...example, usesVoseo: false });

    expect(voseo).not.toBe(tuteo);
    expect(voseo).toMatch(/tenés/);
    expect(tuteo).toMatch(/tienes/);
  });

  it('le pide presentarse como asistente virtual y no fingir ser una persona (5.1)', () => {
    expect(buildSystemPrompt(example)).toMatch(/asistente virtual/i);
    expect(buildSystemPrompt(example)).toMatch(/nunca fingís ser una persona/i);
  });

  it('nombra las herramientas que existen, y solo esas', () => {
    const prompt = buildSystemPrompt(example);
    // Los nombres con forma de herramienta (verbo_cosa) que menciona el prompt.
    const mentioned = new Set(
      [...prompt.matchAll(/\b((?:buscar|consultar|crear|generar|listar|reprogramar|cancelar|derivar)_[a-zñ_]+)\b/g)].map(
        (match) => match[1],
      ),
    );

    for (const tool of agentTools) expect(prompt).toContain(tool.name);
    expect([...mentioned].sort()).toEqual(agentTools.map((tool) => tool.name).sort());
    // generar_pago_seña llega en H9: hasta entonces el prompt no puede prometerla.
    expect(prompt).not.toContain('generar_pago_seña');
  });

  it('ante un precio inventado por la clienta, pide decir el precio real buscándolo con la herramienta', () => {
    // Lo encontró la evaluación inyeccion_precio: el modelo no aceptaba el precio, pero tampoco
    // decía el verdadero, y la clienta tenía que volver a preguntar.
    expect(buildSystemPrompt(example)).toMatch(/precio real.*buscar_servicios/s);
  });

  it('no nombra servicios de memoria, ni como ejemplo: los busca en el catálogo', () => {
    // Lo encontró la prueba manual: a "hola" contestó "por ejemplo, manicura, depilación o
    // masajes" sin llamar a ninguna herramienta, y masajes no está en el catálogo.
    expect(buildSystemPrompt(example)).toMatch(/nunca nombres servicios de memoria/i);
  });

  it('prohíbe pedir o repetir detalles de salud (regla 9)', () => {
    expect(buildSystemPrompt(example)).toMatch(/salud/i);
    expect(buildSystemPrompt(example)).toMatch(/no le pidas ni le repitas detalles/i);
  });
});

describe('buildSystemPrompt: derivar a una persona (4.8)', () => {
  const prompt = buildSystemPrompt(example);

  it('ya no dice que no puede derivar, y la derivación tiene su propia sección', () => {
    expect(prompt).not.toMatch(/todavía no podés derivar/i);
    expect(prompt).toMatch(/## Derivar a una persona/);
  });

  it('nombra todos los motivos de la herramienta, con los mismos nombres que ve el modelo', () => {
    const tool = agentTools.find((candidate) => candidate.name === 'derivar_a_persona');
    if (!tool) throw new Error('No está derivar_a_persona');
    const motivos = (z.toJSONSchema(tool.input, { io: 'input' }) as unknown as {
      properties: { motivo: { enum: string[] } };
    }).properties.motivo.enum;

    expect(motivos).toHaveLength(8);
    for (const motivo of motivos) expect(prompt, motivo).toContain(motivo);
  });

  it('pide derivar cuando la clienta pide una persona, se queja, manda una imagen, quiere un servicio con consulta previa o pide una excepción', () => {
    expect(prompt).toMatch(/pide hablar con una persona/i);
    expect(prompt).toMatch(/queja|enojo/i);
    expect(prompt).toMatch(/\[Imagen\]/);
    expect(prompt).toMatch(/consulta previa/i);
    expect(prompt).toMatch(/devolución|excepción/i);
    expect(prompt).toMatch(/dos intentos/i);
    // Cancelar o reprogramar fuera de plazo lo deriva la herramienta, no el modelo (4.6).
    expect(prompt).toMatch(/cancelar_turno y reprogramar_turno lo derivan solos/);
  });

  it('con temas de salud: no pide ni repite detalles, deriva como tema sensible y el resumen no lleva datos de salud (regla 9)', () => {
    expect(prompt).toMatch(/no le pidas ni le repitas detalles/i);
    expect(prompt).toMatch(/tema_sensible/);
    expect(prompt).toMatch(/resumen[^.]*sin ningún dato de salud/i);
  });

  it('ante un servicio que no está en el catálogo o un dato no cargado, ofrece una persona y deriva solo si acepta o insiste', () => {
    expect(prompt).toMatch(/no está en el catálogo[^.]*ofrecele que la ayude una persona/i);
    expect(prompt).toMatch(/solo si (ella )?acepta o insiste/i);
  });

  it('después de derivar usa el texto de cuándo que devuelve la herramienta y no promete nada más', () => {
    expect(prompt).toMatch(/«cuando»/);
    expect(prompt).toMatch(/no le prometas nada más/i);
    expect(prompt).toMatch(/«opciones» va vacía/);
  });

  it('no deriva de entrada ante un audio: pide que lo escriba y ofrece una persona', () => {
    const audio = prompt.slice(prompt.indexOf('- [Audio]'), prompt.indexOf('- [Sticker]'));

    expect(audio).toMatch(/escriba/);
    expect(audio).toMatch(/ofrecele que una persona/);
    expect(audio).toMatch(/solo si acepta o insiste/);
  });

  it('ante una imagen deriva con el motivo imagen', () => {
    const image = prompt.slice(prompt.indexOf('- [Imagen]'), prompt.indexOf('- [Audio]'));

    expect(image).toMatch(/derivá con el motivo imagen/);
  });

  it('nunca dice que derivó, pasó la consulta o que alguien la va a contactar sin haber llamado a derivar_a_persona', () => {
    // Lo encontró una evaluación: ante una queja contestó «Ya le paso tu reclamo a una persona» sin derivar.
    const rule = /Nunca digas que le pasaste la consulta[^\n]*/.exec(prompt)?.[0] ?? '';

    expect(rule).toMatch(/que la derivaste o que alguien del equipo la va a contactar/);
    expect(rule).toMatch(/si no llamaste a derivar_a_persona en esta misma respuesta/);
    expect(rule).toMatch(/derivada=true/);
    expect(rule).toMatch(/Si corresponde derivar, llamala\./);
  });

  it('llama a derivar_a_persona solo si una regla lo pide y con un resumen real; nunca para probar, por las dudas ni con relleno', () => {
    // Lo encontró una evaluación: derivaciones con resumen «placeholder» e «Ignorar» que pausaban el chat.
    const rule = /Llamá a derivar_a_persona solo cuando[^\n]*/.exec(prompt)?.[0] ?? '';

    expect(rule).toMatch(/solo cuando una de estas reglas lo pide/);
    expect(rule).toMatch(/con un resumen real de lo que necesita la clienta/);
    expect(rule).toMatch(/Nunca la llames para probar, por las dudas, ni con un resumen de relleno/);
    expect(rule).toMatch(/deja al asistente callado en este chat/);
  });

  it('las dos reglas están en la parte de cómo derivar, después de la lista de cuándo', () => {
    const how = prompt.slice(prompt.indexOf('Cómo derivar:'), prompt.indexOf('## Reservar, cancelar y reprogramar turnos'));

    expect(how).toContain('Nunca digas que le pasaste la consulta');
    expect(how).toContain('Llamá a derivar_a_persona solo cuando');
  });

  it('sigue siendo idéntico entre llamadas del mismo negocio, para la caché del proveedor', () => {
    expect(buildSystemPrompt({ ...example })).toBe(prompt);
  });
});

describe('buildSystemPrompt: reservar, cancelar y reprogramar turnos (H8)', () => {
  const prompt = buildSystemPrompt(example);
  const section = (from: string, to: string) => prompt.slice(prompt.indexOf(from), prompt.indexOf(to));
  const booking = section('## Reservar, cancelar y reprogramar turnos', '## Mensajes que no son texto');

  it('ya no dice que no puede reservar, cambiar ni cancelar turnos', () => {
    expect(prompt).not.toMatch(/Todavía no podés/);
    expect(prompt).not.toMatch(/lo que todavía no podés hacer/i);
    expect(prompt).not.toMatch(/no ofrezcas reservar/i);
    expect(prompt).not.toMatch(/por ahora una persona del equipo le confirma la reserva/);
  });

  it('tiene su propia sección, que nombra las cuatro herramientas de turnos', () => {
    expect(booking.length).toBeGreaterThan(500);
    for (const name of ['crear_reserva', 'listar_turnos_de_la_clienta', 'cancelar_turno', 'reprogramar_turno']) {
      expect(booking, name).toContain(name);
    }
  });

  it('reservar: solo con el id de un horario que devolvió consultar_disponibilidad o eligió la clienta; nunca inventa ni arma uno', () => {
    expect(booking).toMatch(/id de un horario que devolvió consultar_disponibilidad/);
    expect(booking).toMatch(/la clienta eligió con un botón/);
    expect(booking).toMatch(/nunca inventes ni armes un id/i);
  });

  it('reservar: si no hay nombre cargado, lo pide antes de reservar', () => {
    expect(booking).toMatch(/no tiene un nombre cargado[^.]*pedile el nombre[^.]*antes de reservar/is);
  });

  it('reservar: solo dice reservado, anotado o te guardo cuando crear_reserva respondió que salió bien', () => {
    expect(booking).toMatch(/«reservado», «anotado»[^.]*«te guardo»[^.]*crear_reserva respondió reservado=true/s);
  });

  it('reservar: si el horario se ocupó, vuelve a consultar y ofrece otros', () => {
    expect(booking).toMatch(/se ocupó[^.]*volvé a consultar[^.]*ofrecele otros/is);
  });

  it('seña: el monto y el plazo tal cual los escribe la herramienta, y una persona le pasa los datos por el chat; no inventa datos de pago', () => {
    expect(booking).toMatch(/pendiente de seña[^.]*monto[^.]*hasta cuándo/is);
    expect(booking).toMatch(/una persona del equipo le pasa por este mismo chat los datos para pagarla/);
    expect(booking).toMatch(/no inventes alias, cbu, links ni datos de pago/i);
  });

  it('cancelar: identifica el turno, pide confirmación con confirmada=false y cancela solo cuando la clienta confirmó', () => {
    expect(booking).toMatch(/identificá el turno con listar_turnos_de_la_clienta/i);
    expect(booking).toMatch(/cancelar_turno con confirmada=false/);
    expect(booking).toMatch(/«Sí, cancelar»/);
    expect(booking).toMatch(/confirmada=true[^.]*solo cuando la clienta confirmó/is);
  });

  it('reprogramar: consulta la disponibilidad con el servicio y la profesional del turno y llama a reprogramar_turno cuando elige', () => {
    expect(booking).toMatch(/servicio y la profesional de ese turno/);
    expect(booking).toMatch(/reprogramar_turno/);
    expect(booking).toMatch(/elegir el horario ya es la confirmación/i);
  });

  it('reservar: si crear_reserva dice que falta que la clienta elija el horario, se lo ofrece como opción sin darlo por hecho', () => {
    const reserve = section('Reservar:', 'Cancelar:');

    expect(reserve).toMatch(/crear_reserva responde que falta que la clienta elija el horario/);
    expect(reserve).toMatch(/ofrecéselo como opción[^.]*frase corta[^.]*¿Te lo reservo\?/s);
    expect(reserve).toMatch(/sin darlo por hecho/);
  });

  it('reprogramar: si reprogramar_turno dice que falta que elija el horario, se lo ofrece como opción sin darlo por hecho', () => {
    const reschedule = section('Reprogramar:', 'Cuando no corresponde:');

    expect(reschedule).toMatch(/reprogramar_turno responde que falta que la clienta elija el horario/);
    expect(reschedule).toMatch(/ofrecéselo como opción[^.]*frase corta[^.]*¿Lo paso a ese horario\?/s);
    expect(reschedule).toMatch(/sin darlo por hecho/);
  });

  it('cancelar: el botón que se ofrece es el opcionId que devuelve cancelar_turno, no el id del turno', () => {
    const cancel = section('Cancelar:', 'Reprogramar:');

    expect(cancel).toMatch(/botón[^.]*es el opcionId que devuelve cancelar_turno, no el id del turno/);
  });

  it('cancelar: para elegir entre varios turnos, las opciones son el opcionId de cada turno de la lista', () => {
    const cancel = section('Cancelar:', 'Reprogramar:');

    expect(cancel).toMatch(/opcionId de cada turno/);
  });

  it('en las elecciones, el id de cada opción es el campo opcionId de la herramienta y no el id del servicio o del turno', () => {
    const choices = section('## Elecciones con botones o lista', '## Derivar a una persona');

    expect(choices).toMatch(/campo «opcionId»/);
    expect(choices).toMatch(/no el id del servicio, que es para las herramientas/);
  });

  it('si cancelar o reprogramar derivaron: explica la política con amabilidad, dice cuándo responde una persona y no discute ni promete excepciones', () => {
    expect(booking).toMatch(/derivada=true/);
    expect(booking).toMatch(/política con amabilidad/);
    expect(booking).toMatch(/cuándo le responde una persona/);
    expect(booking).toMatch(/no discutas ni prometas excepciones/i);
    expect(booking).toMatch(/no llames a derivar_a_persona de nuevo/i);
  });

  it('solo ve y cambia los turnos de la clienta que escribe', () => {
    expect(booking).toMatch(/solo podés ver y cambiar los turnos de la clienta que te escribe/i);
    expect(booking).toMatch(/de otra persona[^.]*no podés/i);
  });

  it('"De dónde sale cada dato" incluye los turnos y el resultado de reservar, cancelar y reprogramar', () => {
    const data = section('## De dónde sale cada dato', '## Elecciones con botones o lista');

    expect(data).toContain('listar_turnos_de_la_clienta');
    expect(data).toMatch(/crear_reserva/);
  });

  it('sigue siendo idéntico entre llamadas del mismo negocio, sin fechas ni datos de la clienta', () => {
    expect(buildSystemPrompt({ ...example })).toBe(prompt);
    expect(prompt).not.toMatch(/\d{1,2}:\d{2}/);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
