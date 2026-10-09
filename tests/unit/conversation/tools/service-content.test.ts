import { describe, expect, it } from 'vitest';
import type { CatalogService } from '../../../../src/modules/catalog/queries.js';
import {
  describeDuration,
  describePrice,
  serviceContent,
  serviceOption,
} from '../../../../src/modules/conversation/tools/service-content.js';

const MICA = { id: '00000000-0000-4000-8000-000000000101', name: 'Mica', durationOverrideMinutes: null };
const SOFI = { id: '00000000-0000-4000-8000-000000000102', name: 'Sofi', durationOverrideMinutes: 75 };

function service(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    name: 'Esmaltado semipermanente',
    aliases: ['semi'],
    category: 'Manos',
    durationMinutes: 60,
    bufferMinutes: 10,
    priceCents: 1_800_000,
    cashPriceCents: 1_600_000,
    priceType: 'fixed',
    requiresConsultation: false,
    professionals: [MICA, SOFI],
    ...overrides,
  };
}

describe('describePrice: el precio escrito por el código (4.1)', () => {
  it('un precio fijo con precio en efectivo', () => {
    expect(describePrice({ priceCents: 1_800_000, cashPriceCents: 1_600_000, priceType: 'fixed' })).toBe(
      '$18.000 ($16.000 en efectivo o transferencia)',
    );
  });

  it('un precio fijo sin precio en efectivo', () => {
    expect(describePrice({ priceCents: 500_000, cashPriceCents: null, priceType: 'fixed' })).toBe('$5.000');
  });

  it('un precio "desde" aclara que el final lo confirma la profesional', () => {
    expect(describePrice({ priceCents: 2_500_000, cashPriceCents: null, priceType: 'from' })).toBe(
      'desde $25.000, el precio final lo confirma la profesional',
    );
  });

  it('en un precio "desde", el de efectivo también es "desde"', () => {
    expect(describePrice({ priceCents: 2_800_000, cashPriceCents: 2_500_000, priceType: 'from' })).toBe(
      'desde $28.000 (desde $25.000 en efectivo o transferencia), el precio final lo confirma la profesional',
    );
  });
});

describe('describeDuration: cuánto dura, con lo que cambia por profesional', () => {
  it('la duración del servicio cuando nadie la cambia', () => {
    expect(describeDuration(60, [MICA])).toBe('60 min');
  });

  it('avisa qué profesional tarda distinto', () => {
    expect(describeDuration(60, [MICA, SOFI])).toBe('60 min (con Sofi, 75 min)');
  });

  it('varias profesionales con duración propia', () => {
    const ana = { id: 'x', name: 'Ana', durationOverrideMinutes: 90 };
    expect(describeDuration(60, [MICA, SOFI, ana])).toBe('60 min (con Sofi, 75 min; con Ana, 90 min)');
  });

  it('una duración propia igual a la del servicio no es un cambio', () => {
    expect(describeDuration(60, [{ ...SOFI, durationOverrideMinutes: 60 }])).toBe('60 min');
  });
});

describe('serviceContent: lo que lee el modelo de cada servicio', () => {
  it('trae el id, los precios escritos, la duración y quién lo hace', () => {
    expect(serviceContent(service())).toEqual({
      id: '00000000-0000-4000-8000-000000000201',
      nombre: 'Esmaltado semipermanente',
      categoria: 'Manos',
      precio: '$18.000',
      precioEfectivo: '$16.000',
      tipoPrecio: 'fijo',
      precioTexto: '$18.000 ($16.000 en efectivo o transferencia)',
      duracionMinutos: 60,
      duracionTexto: '60 min (con Sofi, 75 min)',
      requiereConsultaPrevia: false,
      profesionales: [
        { id: MICA.id, nombre: 'Mica', duracionMinutos: 60 },
        { id: SOFI.id, nombre: 'Sofi', duracionMinutos: 75 },
      ],
    });
  });

  it('un servicio "desde" sin precio en efectivo', () => {
    const content = serviceContent(
      service({ priceType: 'from', priceCents: 2_800_000, cashPriceCents: null, requiresConsultation: true }),
    );

    expect(content).toMatchObject({
      precio: '$28.000',
      precioEfectivo: null,
      tipoPrecio: 'desde',
      precioTexto: 'desde $28.000, el precio final lo confirma la profesional',
      requiereConsultaPrevia: true,
    });
  });
});

describe('serviceOption: la fila de la lista para elegir un servicio', () => {
  it('el id es servicio:<uuid> y el título es el nombre si entra', () => {
    const option = serviceOption(service({ name: 'Depilación láser', priceCents: 2_500_000, priceType: 'from' }));

    expect(option).toEqual({
      id: 'servicio:00000000-0000-4000-8000-000000000201',
      title: 'Depilación láser',
      description: 'desde $25.000 · 60 min',
    });
  });

  it('si el nombre no entra en 20 caracteres, se acorta y el nombre completo pasa a la descripción', () => {
    const option = serviceOption(service());

    expect(option.title).toBe('Esmaltado…');
    expect(option.description).toBe('Esmaltado semipermanente · $18.000 · 60 min');
  });

  it('respeta los límites de WhatsApp aunque el nombre sea larguísimo', () => {
    const option = serviceOption(service({ name: 'Servicio '.repeat(20).trim() }));

    expect(option.title.length).toBeLessThanOrEqual(20);
    expect(option.description?.length).toBeLessThanOrEqual(72);
  });
});
