/**
 * ¿El texto afirma que un turno quedó reservado, cancelado, reprogramado o confirmado? (6.4)
 *
 * El asistente nunca confirma un cambio que no pasó: si el texto lo afirma y en la vuelta ninguna
 * herramienta lo hizo, el ciclo del agente se lo hace notar al modelo. Es pura.
 *
 * Detecta la afirmación de algo hecho: «quedó reservado», «ya te quedó reprogramado», «te lo reservé»,
 * «cancelé tu turno», «lo paso al miércoles», «listo, anotado». No cuenta lo que no afirma nada:
 * preguntas y ofertas («¿te lo reservo?», «si querés, lo paso al jueves»), negaciones («no se canceló
 * nada», «no quedó reservado») ni la descripción de un turno que ya existía («tenés un turno reservado
 * para el viernes»).
 *
 * Hay dos clases de error y no cuestan lo mismo. Si no hubo cambio, un falso positivo cuesta una llamada
 * más al modelo; pero si el modelo vuelve a escribir lo mismo, la clienta recibe el texto fijo «no te
 * entendí». Un falso negativo deja pasar una confirmación falsa. Por eso se prefieren las frases que de
 * verdad afirman un cambio y se dejan afuera las que se parecen a una descripción: el presente «queda
 * reservado» (las políticas de seña lo usan: «si no pagás, queda cancelado») y un «reservado» o un
 * «confirmado» sueltos en medio de la frase («tenés un turno confirmado»).
 *
 * Desde H9 cuenta también «confirmado» como algo que pasó («quedó confirmado», «se acreditó la seña»,
 * «recibí la transferencia»): una transferencia la confirma siempre la dueña (4.5), y después de recibir
 * el comprobante el asistente no puede decir que la seña llegó. Una reserva sin seña sí lo confirma
 * (`crear_reserva` marca el cambio), y lo que confirma la dueña se lo avisa el código a la clienta.
 *
 * Trabaja sobre el texto con tildes: «cancelé» (hice) y «cancele» (que cancele) son frases distintas.
 */

const LETTER_OR_DIGIT = String.raw`\p{L}\p{N}`;

/** Una palabra o frase completa: el `\b` de JavaScript no entiende las tildes. */
const phrase = (body: string): string => String.raw`(?<![${LETTER_OR_DIGIT}])(?:${body})(?![${LETTER_OR_DIGIT}])`;

/** El estado de un turno, ya hecho: «reservado», «cancelada», «reprogramados». */
const DONE = String.raw`(?:reservad|cancelad|reprogramad|agendad|anotad|confirmad|aprobad|acreditad)[oa]s?`;

interface ClaimPattern {
  regex: RegExp;
  /**
   * Habla del resultado y no de quien lo hizo («quedó cancelado», «se canceló»): puede ser la explicación
   * de un cambio anterior («quedó cancelado porque venció la seña») y entonces no cuenta.
   */
  describesResult: boolean;
}

const result = (body: string): ClaimPattern => ({ regex: new RegExp(body, 'gu'), describesResult: true });
const action = (body: string): ClaimPattern => ({ regex: new RegExp(body, 'gu'), describesResult: false });

/** Lo que se dice antes del estado: «listo, reprogramado», «perfecto, ya anotado». */
const CONFIRMATION_OPENERS = 'listo|perfecto|dale|genial|excelente|ok|bueno|buenísimo|buenisimo';

const CLAIM_PATTERNS: ClaimPattern[] = [
  // «quedó reservado», «ya te quedó reprogramado», «quedó todo anotado», «quedaron reservados»
  result(phrase(String.raw`qued(?:ó|aron)(?: \S+){0,3}? ${DONE}`)),
  // «tu turno quedó para el viernes»
  result(phrase(String.raw`turno qued[óa] para`)),
  // «ya te quedó el turno para el jueves»
  result(phrase(String.raw`ya te quedó (?:el|tu) turno`)),
  // «se canceló», «se reprogramó»
  result(phrase(String.raw`se (?:canceló|reprogramó|reservó|agendó|confirmó|acreditó|aprobó)`)),
  // «tu seña quedó aprobada» la cubre «quedó»; «seña acreditada» suelta también afirma
  result(phrase(String.raw`seña (?:acreditada|aprobada|confirmada)`)),
  // Una confirmación suelta, al empezar la frase: «listo, reprogramado», «anotado», «¡agendado!»
  result(String.raw`^(?:(?:${CONFIRMATION_OPENERS})[ ,]+)*(?:ya )?${phrase(DONE)}`),
  // «te lo reservé», «cancelé tu turno», «reprogramé», «agendé»
  action(phrase('reservé|cancelé|reprogramé|agendé|confirmé|acredité')),
  // «recibí la transferencia», «ya recibimos tu seña»; «recibí el comprobante» no afirma que llegó la plata (4.5)
  action(phrase(String.raw`recib(?:í|imos) (?:la|tu) (?:transferencia|seña|pago)`)),
  // «te pasé el turno al miércoles», «ya lo pasé al jueves», «lo moví», «lo cambié»
  action(phrase(String.raw`lo (?:pasé|moví|cambié)|(?:pasé|moví|cambié) (?:tu|el) turno`)),
  // «lo paso al miércoles a las 15:30»: el destino lo vuelve una acción hecha, no una oferta
  action(phrase(String.raw`lo paso (?:al|a la|a las|a|para)`)),
  // «te anoté para el viernes»; «anoté tu nombre» no es un turno
  action(phrase(String.raw`(?:te|lo) anoté|anoté (?:tu|el) turno`)),
];

/** Una pregunta: de «¿» a «?», o desde el comienzo de la frase hasta un «?» sin «¿». */
const QUESTIONS = /¿[^?]*\?|[^.!?\n¿]*\?/gu;

/** Lo que vuelve a una frase una oferta o una condición: lo que viene después no es algo hecho. */
const OFFER = new RegExp(
  phrase(
    [
      'si (?:querés|queres|quieres|preferís|preferis|gustás|gustas|te parece|te sirve)',
      'cuando (?:quieras|elijas|confirmes|me confirmes)',
      'querés que',
      'puedo',
      'podemos',
      'podría',
    ].join('|'),
  ),
  'u',
);

const NEGATION = new RegExp(phrase('no|nunca|tampoco|ni'), 'u');

/** Explica por qué un turno está como está («quedó cancelado porque venció la seña»). */
const EXPLANATION = new RegExp(
  phrase(
    'porque|ya que|venció|vencido|vencimiento|expiró|expirado|se pasó el plazo|falta de pago|no se pagó|automáticamente',
  ),
  'u',
);

/** Minúsculas y sin signos, pero con las tildes; las comas quedan: separan las cláusulas. */
function fold(sentence: string): string {
  return sentence
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N},;]+/gu, ' ')
    .replace(/;/g, ',')
    .replace(/ ?, ?/g, ', ')
    .trim();
}

function claimsInSentence(sentence: string): boolean {
  return CLAIM_PATTERNS.some(({ regex, describesResult }) => {
    if (describesResult && EXPLANATION.test(sentence)) return false;
    return [...sentence.matchAll(regex)].some((match) => {
      const before = sentence.slice(0, match.index);
      if (OFFER.test(before)) return false;
      // La negación vale dentro de su cláusula: «no hay problema, ya te lo reservé» sí afirma.
      return !NEGATION.test(before.slice(before.lastIndexOf(',') + 1));
    });
  });
}

export function claimsAppointmentChange(text: string): boolean {
  return text
    .replace(QUESTIONS, ' ')
    .split(/[.!\n]+/)
    .map(fold)
    .some(claimsInSentence);
}
