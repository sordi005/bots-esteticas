/**
 * Búsqueda de servicios por el texto de la clienta (herramienta `buscar_servicios`, 6.4).
 * Función pura: recibe el catálogo ya leído y devuelve los servicios que coinciden.
 *
 * Se compara sin tildes ni mayúsculas ("Pestanas" encuentra "pestañas") y por palabras
 * enteras. Criterio, en este orden (el primero que encuentra algo es el que vale):
 *
 *  1. Exacto: el texto es igual al nombre o a un alias. Es lo que la dueña declaró como
 *     "cómo lo pide la gente", así que "semi" es el esmaltado y "semi en pies" es el de pies.
 *  2. Cobertura total: cada palabra del texto (sin las de relleno: "en", "de", "con"…) está
 *     entre las palabras del nombre, los alias o la categoría. "semi pies" encuentra el de
 *     pies; "manos" trae todos los de la categoría Manos.
 *  3. Frase contenida: el texto contiene un nombre o alias completo ("hola, quiero sacar el
 *     semi"). Van primero los que coinciden con la frase más larga, que es la más específica.
 *
 * Si hay varias coincidencias, se devuelven todas, en el orden en que llegó el catálogo (o,
 * en el caso 3, de la más específica a la menos): decidir entre ellas es del modelo, que
 * puede preguntarle a la clienta.
 */

export interface SearchableService {
  name: string;
  aliases: readonly string[];
  category?: string;
}

/** Palabras que no distinguen un servicio de otro. */
const FILLER_WORDS = new Set([
  'a', 'al', 'con', 'de', 'del', 'e', 'el', 'en', 'la', 'las', 'lo', 'los', 'o', 'para', 'por', 'un', 'una', 'y',
]);

/** Minúsculas, sin tildes (la ñ queda como n) y con los signos y espacios repetidos juntos. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function words(normalized: string): string[] {
  return normalized.split(' ').filter((word) => word !== '');
}

export function matchServices<T extends SearchableService>(services: readonly T[], text: string): T[] {
  const query = normalizeText(text);
  const queryWords = words(query).filter((word) => !FILLER_WORDS.has(word));
  if (queryWords.length === 0) return [];

  const candidates = services.map((service) => {
    const terms = [service.name, ...service.aliases].map(normalizeText).filter((term) => term !== '');
    const knownWords = new Set([...terms.flatMap(words), ...words(normalizeText(service.category ?? ''))]);
    return { service, terms, knownWords };
  });

  const exact = candidates.filter(({ terms }) => terms.includes(query));
  if (exact.length > 0) return exact.map(({ service }) => service);

  const coveringAll = candidates.filter(({ knownWords }) =>
    queryWords.every((word) => knownWords.has(word)),
  );
  if (coveringAll.length > 0) return coveringAll.map(({ service }) => service);

  // Con espacios en los bordes, "esmaltado" no se encuentra dentro de "esmaltadora".
  const padded = ` ${query} `;
  return candidates
    .map(({ service, terms }) => ({
      service,
      longestPhrase: Math.max(0, ...terms.filter((term) => padded.includes(` ${term} `)).map((term) => term.length)),
    }))
    .filter(({ longestPhrase }) => longestPhrase > 0)
    .sort((a, b) => b.longestPhrase - a.longestPhrase)
    .map(({ service }) => service);
}
