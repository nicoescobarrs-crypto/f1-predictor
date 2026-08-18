"""Regenera la carpeta lista para subir a GitHub a mano.

    python actualizar_subida.py

Copia el proyecto a ../f1-predictor-SUBIR-A-GITHUB dejando fuera lo que no debe
subirse (la cache de FastF1 son cientos de MB). Uselo despues de cada
'python pipeline/run.py --refrescar' para tener los JSON nuevos a mano.

No usa git: sirve igual si subes los archivos arrastrandolos en la web de GitHub.
"""
from __future__ import annotations

import shutil
from pathlib import Path

ORIGEN = Path(__file__).resolve().parent
DESTINO = ORIGEN.parent / "f1-predictor-SUBIR-A-GITHUB"

# Carpetas que NUNCA se suben: pesan mucho y se regeneran solas.
CARPETAS_FUERA = {"cache", "data", "__pycache__", ".git", ".ipynb_checkpoints",
                  ".firebase", "venv", ".venv"}
EXTENSIONES_FUERA = {".pyc", ".pyo"}


def se_copia(ruta: Path) -> bool:
    partes = ruta.relative_to(ORIGEN).parts
    # 'data' solo se excluye en la raiz: web/data SI se sube, es lo que
    # alimenta la pagina publicada.
    if partes[0] in CARPETAS_FUERA:
        return False
    if any(p in {"__pycache__", ".ipynb_checkpoints"} for p in partes):
        return False
    return ruta.suffix not in EXTENSIONES_FUERA


def main() -> None:
    if DESTINO.exists():
        shutil.rmtree(DESTINO)
    DESTINO.mkdir(parents=True)

    copiados = 0
    total = 0
    for f in ORIGEN.rglob("*"):
        if not f.is_file() or not se_copia(f):
            continue
        rel = f.relative_to(ORIGEN)
        salida = DESTINO / rel
        salida.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, salida)
        copiados += 1
        total += f.stat().st_size

    jsons = len(list((DESTINO / "web" / "data").rglob("*.json")))

    print(f"Carpeta lista: {DESTINO}")
    print(f"  {copiados} archivos, {total/1024/1024:.1f} MB")
    print(f"  {jsons} JSON en web/data")

    if jsons == 0:
        print("\n  AVISO: no hay datos en web/data.")
        print("  Ejecuta antes:  python pipeline/run.py --refrescar")
    else:
        print("\nAhora subelos a GitHub:")
        print("  1. Abre la carpeta en el Explorador")
        print("  2. Ctrl+E para seleccionar todo el CONTENIDO (no la carpeta)")
        print("  3. Arrastralo a GitHub -> Add file -> Upload files")


if __name__ == "__main__":
    main()
