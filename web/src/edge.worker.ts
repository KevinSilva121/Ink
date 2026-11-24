// Calcula o mapa de bordas do recorte "ímã" fora da tela principal: num celular fraco essa
// conta leva segundos e, na tela principal, travava o desenho do contorno.
import { edgeCost } from './magnet';

self.onmessage = (e: MessageEvent<{ rgba: Uint8ClampedArray; w: number; h: number }>) => {
  const { rgba, w, h } = e.data;
  const cost = edgeCost(rgba, w, h);
  (self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void }).postMessage(cost, [cost.buffer]);
};
