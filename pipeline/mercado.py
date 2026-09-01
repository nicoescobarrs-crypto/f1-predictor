"""Precios de Polymarket para los mercados de F1.

Polymarket es un mercado de predicciones: la gente compra y vende contratos que
pagan 1 dolar si el suceso ocurre. El precio, por tanto, se lee directamente
como probabilidad: pagar 0.74 por un contrato equivale a decir "creo que hay un
74 % de posibilidades".

Su API es publica y no exige clave ni registro.

Solo existen mercados de TEMPORADA (campeon de pilotos y de constructores); no
hay uno por carrera, asi que la comparacion con nuestro modelo se hace sobre el
campeonato, no sobre un Gran Premio suelto.
"""
from __future__ import annotations

import json
import urllib.request

GAMMA = "https://gamma-api.polymarket.com/events?closed=false&limit=100&offset={}"
TIMEOUT = 25
MAX_PAGINAS = 25          # la API pagina de 100 en 100

TITULOS = {
    "pilotos":  "F1 Drivers' Champion",
    "equipos":  "F1 Constructors' Champion",
}


def _pedir(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "f1-predictor/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def _precio(m: dict) -> float | None:
    """Precio del resultado 'Si' de un mercado, que es su probabilidad."""
    try:
        precios = json.loads(m.get("outcomePrices") or "[]")
        return float(precios[0]) if precios else None
    except Exception:
        return None


def buscar_eventos() -> dict[str, dict]:
    """Recorre los eventos abiertos y devuelve los de F1 que nos interesan."""
    encontrados: dict[str, dict] = {}
    buscados = {t: k for k, t in TITULOS.items()}

    for pagina in range(MAX_PAGINAS):
        try:
            lote = _pedir(GAMMA.format(pagina * 100))
        except Exception:
            break
        if not lote:
            break

        for ev in lote:
            titulo = (ev.get("title") or "").strip()
            if titulo in buscados:
                encontrados[buscados[titulo]] = ev

        if len(encontrados) == len(TITULOS):
            break
    return encontrados


def cuotas() -> dict | None:
    """Probabilidades implicitas del mercado, normalizadas.

    La suma de precios rara vez da exactamente 1: la diferencia es el margen del
    mercado. Se reparte proporcionalmente para poder comparar de tu a tu con las
    probabilidades del modelo, que si suman 1.
    """
    eventos = buscar_eventos()
    if not eventos:
        return None

    salida = {"fuente": "Polymarket", "mercados": {}}

    for clave, ev in eventos.items():
        filas = []
        for m in ev.get("markets", []):
            p = _precio(m)
            nombre = (m.get("groupItemTitle") or m.get("question") or "").strip()
            if p is not None and nombre:
                filas.append({"nombre": nombre, "precio": p})

        if not filas:
            continue

        bruto = sum(f["precio"] for f in filas)
        for f in filas:
            f["prob"] = f["precio"] / bruto if bruto > 0 else 0.0
        filas.sort(key=lambda f: -f["prob"])

        salida["mercados"][clave] = {
            "titulo": ev.get("title"),
            "slug": ev.get("slug"),
            "cierra": str(ev.get("endDate") or "")[:10],
            "volumen": float(ev.get("volume") or 0),
            "liquidez": float(ev.get("liquidity") or 0),
            "suma_bruta": bruto,
            "opciones": filas,
        }

    return salida if salida["mercados"] else None


# ------------------------------- prueba rapida -------------------------------
if __name__ == "__main__":
    d = cuotas()
    if not d:
        print("No se pudo leer Polymarket.")
        raise SystemExit(1)

    for clave, m in d["mercados"].items():
        print(f"\n{m['titulo']}  (cierra {m['cierra']}, "
              f"volumen ${m['volumen']:,.0f})")
        print(f"  suma de precios sin normalizar: {m['suma_bruta']:.3f}")
        for f in m["opciones"][:8]:
            print(f"    {f['nombre'][:26]:<26} {f['prob']*100:>6.2f}%")
