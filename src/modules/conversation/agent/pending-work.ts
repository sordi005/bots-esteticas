import { normalizeText } from '../../catalog/service-search.js';

/**
 * ¿El texto anuncia que la asistente va a buscar o hacer algo y después sigue? (6.4)
 *
 * Cada respuesta es la única de la vuelta: si el modelo escribe «dejame consultar…» sin llamar a ninguna
 * herramienta, la clienta no recibe nada más. Es pura y trabaja sobre el texto normalizado (sin tildes
 * ni mayúsculas ni signos).
 *
 * Detecta anuncios de una acción futura de la propia asistente, en primera persona. Las ofertas («¿querés
 * que te busque otros horarios?», «si querés, te busco…») no cuentan: ahí la que decide es la clienta.
 * Donde la frontera es dudosa se prefiere detectar de más: una detección equivocada cuesta una llamada
 * más al modelo, que vuelve a contestar lo mismo; una omisión deja a la clienta sin respuesta.
 */

/** Verbos de consultar, en infinitivo y en subjuntivo («dejame que consulte»). */
const LOOK_UP = [
  'consultar', 'buscar', 'revisar', 'ver', 'fijarme', 'chequear', 'verificar', 'averiguar', 'mirar', 'controlar',
  'consulte', 'busque', 'revise', 'vea', 'fije', 'chequee', 'verifique', 'averigue', 'mire', 'controle',
];

/** Verbos de actuar sobre un turno: sin herramienta, anunciarlos tampoco hace nada. */
const ACT_ON_APPOINTMENT = ['cancelar', 'reprogramar', 'mover', 'reservar', 'agendar', 'anotar'];

/** Primera persona del presente de los verbos de consultar («ya te busco»). */
const LOOK_UP_NOW = ['busco', 'consulto', 'reviso', 'chequeo', 'verifico', 'miro', 'fijo', 'averiguo', 'controlo'];

/**
 * «un momento», «un segundo»… «un segundo turno» es otra cosa, «hace un momento» mira hacia atrás y «te
 * responde en un momento» es el texto de una derivación: corregirlo arriesgaría que el modelo la suelte.
 */
const WAIT_FOR_ME = [
  /(?<!hace |en )\bun (?:momentito|momento|instante|ratito|minutito|minuto|segundito)\b/,
  /\bun segundo\b(?! (?:turno|servicio|pago|horario|dia|mensaje|intento|lugar)\b)/,
  /\b(?:esperame|aguantame|aguardame)\b/,
];

const alternatives = (words: string[]): string => `(?:${words.join('|')})`;

/** Primera persona del presente de entregar algo («te paso la dirección»). */
const HAND_OVER = ['paso', 'mando', 'envio', 'comparto'];
/** «ahora mismo» al final de «te paso…»; «ahora mismo no tengo…» no tiene «te paso» y no entra. */
const RIGHT_NOW = ['ahora mismo', 'ahora', 'enseguida', 'en seguida', 'ya mismo'];

const PENDING_WORK_PATTERNS: RegExp[] = [
  // «dejame consultar», «déjame ver», «dejame que me fije»
  new RegExp(String.raw`\bdejame (?:que )?(?:me )?${alternatives(LOOK_UP)}\b`),
  // «voy a buscar», «voy a intentar», «voy a cancelar tu turno»; «voy a necesitar tu nombre» no entra
  new RegExp(String.raw`\bvoy a ${alternatives([...LOOK_UP, ...ACT_ON_APPOINTMENT, 'intentar'])}\b`),
  // «ya te busco», «ahora consulto», «enseguida me fijo»
  new RegExp(String.raw`\b(?:ya|ahora|enseguida|en seguida|ya mismo) (?:te |me )?${alternatives(LOOK_UP_NOW)}\b`),
  // «lo reviso y te confirmo», «lo consulto»
  new RegExp(String.raw`\blo ${alternatives(LOOK_UP_NOW)}\b`),
  // «voy a pasar tu turno al miércoles»; «te voy a pasar con una persona» es una derivación y no entra
  /\bvoy a pasar(?:te)? (?:tu|el) turno\b/,
  // «te paso la dirección ahora mismo», «te mando los precios enseguida»; «te paso con una persona» es una derivación
  new RegExp(String.raw`\bte ${alternatives(HAND_OVER)} (?!con\b)(?:\S+ ){0,6}?${alternatives(RIGHT_NOW)}\b`),
  // «ya te paso la dirección», «ahora te mando los precios»
  new RegExp(String.raw`\b(?:ya|${alternatives(RIGHT_NOW)}) te ${alternatives(HAND_OVER)} (?!con\b)`),
  // «estoy buscando tu turno»
  /\bestoy (?:buscando|consultando|revisando|chequeando|verificando|mirando|averiguando)\b/,
  // «lo intento mover», «intento moverlo», «lo voy a intentar»
  /\blo (?:intento|voy a intentar)\b/,
  new RegExp(String.raw`\bintento ${alternatives(ACT_ON_APPOINTMENT)}`),
  ...WAIT_FOR_ME,
];

export function announcesPendingWork(text: string): boolean {
  const normalized = normalizeText(text);
  return PENDING_WORK_PATTERNS.some((pattern) => pattern.test(normalized));
}
