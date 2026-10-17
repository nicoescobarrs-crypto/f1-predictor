/* Respuestas sobre el producto y explicaciones basadas solo en sus datos. */
const AsistentePagina = {
  ultimaPregunta: null,
  _respuesta(texto,sugerencias=[]) { return {texto,bloques:[],sugerencias,intencion:'pagina'}; },
  _fuera() {
    return this._respuesta('Solo puedo ayudarte con **F1 Predictor**: sus predicciones, pilotos y carreras disponibles, el modelo, la quiniela, tu cuenta, los planes y los escenarios.\n\nNo consulto información ajena a la página ni puedo responder preguntas generales sobre otros temas. Si tu duda se refiere a un dato de aquí, indica el piloto, Gran Premio o apartado y lo revisamos.',
      ['¿Qué puedes hacer?', '¿Cómo se puntúa la quiniela?', '¿Qué incluye cada plan?']);
  },
  async responder(pregunta) {
    const texto=String(pregunta??'').trim().slice(0,600), n=normalizarTexto(texto);
    if(!n)return this._respuesta('Escribe una pregunta sobre F1 Predictor para empezar.');
    if(/^(y )?(por que|explicame mas|mas detalle|puedes ampliar|amplia)( eso)?$/.test(n)) {
      if(!this.ultimaPregunta)return this._respuesta('Indica qué predicción, piloto o apartado quieres que explique con más detalle.');
      return this.responder(this.ultimaPregunta);
    }
    // No interpretar palabras sueltas de F1 como permiso para responder a un tema ajeno.
    if(/\b(ignora|olvida|desobedece)\b.*\b(reglas|instrucciones|limites)\b|\b(receta|cocinar|medicamento|diagnostico|presidente|elecciones|bitcoin|criptomoneda|horoscopo|futbol|traduce|poema|capital de|resuelve la ecuacion|programa en python|clave secreta|service_role|token de acceso)\b/.test(n)) return this._fuera();
    let r;
    if(/\b(plan(?:es)?|vip|experto|basico|precios?|mejorar plan|suscripcion|cuesta|coste)\b/.test(n)) {
      const catalogo=typeof Planes!=='undefined'?Planes.catalogo:[];
      const lista=catalogo.map(p=>`**${p.nombre}**: ${p.precio_cop?'$'+p.precio_cop.toLocaleString('es-CO')+' COP al mes':'gratis'}. `+
        (p.max_escenarios?`Permite guardar hasta ${p.max_escenarios} escenarios y comparar hasta ${p.max_comparacion}. ${p.exportar?'También permite exportar a CSV.':''}`:'Incluye predicciones, histórico, quiniela y el asistente; puedes reordenar la parrilla para experimentar.')).join('\n\n');
      const actual=typeof Planes!=='undefined'?Planes.actual:null;
      r=this._respuesta(lista+'\n\n**Cómo se activa:** entra en Planes y solicita VIP o Experto. Nico o Martín debe asignarlo después de acordar el pago. La página no cobra ni renueva automáticamente; la asignación dura un mes. Un plan de pago no da permisos de administrador.'+
        (actual&&typeof Cuenta!=='undefined'&&Cuenta.sesion?`\n\nTu acceso actual es **${actual.nombre}**${actual.es_admin?' por tu rol de administrador':''}.`:'')+
        '\n\n**Dónde probarlo:** el laboratorio está al final de Predicción. Guardar un escenario no envía ni modifica tu quiniela.',
        ['¿Cómo guardo un escenario?', '¿Cómo se puntúa la quiniela?']);
    } else if(/\b(escenarios?|laboratorio|exportar|csv|comparar parrillas)\b/.test(n)) {
      r=this._respuesta('Un **escenario** es una parrilla de salida alternativa junto con la predicción que obtuviste. Sirve para estudiar cómo cambia el resultado cuando mueves a un piloto.\n\n**Paso a paso:** abre Predicción, selecciona el Gran Premio, cambia el orden con las flechas o arrastrando, escribe un nombre en el laboratorio y pulsa Guardar escenario. VIP guarda hasta 10 y compara dos; Experto guarda hasta 50, compara cinco y exporta a CSV. Selecciona las casillas de los escenarios para comparar o exportar.\n\n**Cómo interpretarlo:** la comparación conserva los resultados del momento de guardar. Cargar un escenario recupera la parrilla y calcula otra vez con los datos actuales. Si cambian los pilotos o el modelo, ambos resultados pueden diferir. Son aproximaciones a partir de curvas precalculadas, no simulaciones completas de incidentes de carrera.\n\nLos escenarios son privados y no cambian la quiniela ni sus puntos.',
        ['¿Qué incluye cada plan?', '¿Qué tan fiable es el modelo?']);
    } else if(/\b(quiniela|puntua|puntuacion|pleno|abandonos|guardar mi top|cierra|plazo)\b/.test(n)) {
      r=this._respuesta('La **quiniela** te permite elegir los diez primeros pilotos de un Gran Premio y compararte con el modelo. Selecciona diez pilotos distintos, ordénalos, indica los abandonos si quieres optar a ese bonus y pulsa Guardar. Debes tener la sesión iniciada.\n\n**Puntuación:** cada posición exacta suma 15 puntos. Si un piloto termina en el top 10 en otra posición, recibes como máximo 5 puntos, menos uno por cada puesto de diferencia, sin bajar de cero. Acertar el ganador añade 25; acertar todo el podio en orden añade 30; acertar los abandonos añade 10. El máximo es **215 puntos**.\n\n**Plazo y resultados:** puedes actualizar tu selección antes de la hora de cierre que muestra el Gran Premio. El servidor comprueba ese plazo. Las quinielas ajenas se muestran tras el cierre y los puntos se calculan cuando un administrador carga y puntúa el resultado oficial. “Pendiente” significa que aún no se ha puntuado; no significa que el guardado haya fallado.\n\nRevisa Tus quinielas después de guardar. El plan no cambia estas reglas ni otorga puntos extra.',
        ['¿Cómo guardo un escenario?', '¿Qué incluye cada plan?']);
    } else if(/\b(cuenta|registr|iniciar sesion|entrar|contrasena|perfil|administrador|admins?)\b/.test(n)) {
      r=this._respuesta('Desde **Entrar** puedes iniciar sesión o elegir Regístrate para crear una cuenta. El registro pide un nombre de usuario, correo y contraseña; si aparece un aviso de confirmación, debes completar el enlace del correo antes de entrar.\n\n**Tu perfil** permite cambiar el nombre visible, la escudería favorita y el avatar. Para guardar la quiniela, comprueba que arriba aparezca tu usuario y que el Gran Premio siga abierto. Si ya guardaste, verás Actualizar quiniela y la fecha de envío.\n\nSolo **Nico y Martín** tienen permisos de administración. Básico, VIP y Experto son niveles de acceso a funciones de experimentación y no convierten a nadie en administrador. No compartas tu contraseña con el asistente: el acceso se completa en el formulario de la página.',
        ['¿Cómo se puntúa la quiniela?', '¿Qué incluye cada plan?']);
    } else if(/\b(mercado|cuotas|polymarket|en vivo)\b/.test(n)) {
      r=this._respuesta('En **Mercado en vivo** puedes comparar las probabilidades del modelo con las cifras publicadas por los mercados que muestra la página. El modelo aprende de datos históricos; el mercado refleja los precios de sus participantes, así que pueden discrepar.\n\n**Cómo leerlo:** comprueba el evento al que corresponde cada dato y su hora de actualización. Un precio o una probabilidad no garantiza el resultado. Una cuota decimal expresa una probabilidad implícita de 1 dividido por la cuota; el margen del mercado puede hacer que las probabilidades de todos los participantes no sumen 100 %.\n\n“En vivo” se refiere a actualizaciones de clasificación y mercados, no a cronometraje vuelta a vuelta. Si una fuente no responde, usa el aviso de la sección para reconocer que el dato no está disponible. No puedo consultar cifras externas que la página no tenga cargadas.',
        ['¿Qué tan fiable es el modelo?', '¿Cómo va el campeonato?']);
    } else {
      let consulta=texto;
      const c=AsistenteLocal.interpretar(consulta);
      if(c.intencion==='desconocida')return this._fuera();
      r=await AsistenteLocal.responder(consulta);
      if(r.intencion==='desconocida')return this._fuera();
      if(c.intencion==='ayuda') {
        r.texto+='\n\nTambién puedo guiarte con el registro, la puntuación de la quiniela, los planes y los escenarios. Si me pides una predicción, separaré la posición prevista de la probabilidad de victoria y explicaré sus límites. No utilizo información externa a F1 Predictor.';
      } else {
        r.texto+=this._interpretacion(c);
        r.texto+=`\n\n**Datos de la página:** ${AsistenteLocal.datos.indice.generado??'consulta el pie de página para ver la actualización'}. El histórico y las predicciones reflejan esa versión de los datos; consulta los apartados en vivo para sus actualizaciones específicas.`;
      }
    }
    this.ultimaPregunta=texto;
    return r;
  },
  _interpretacion(c) {
    switch(c.intencion) {
      case 'prediccion': return '\n\n**Cómo interpretarlo:** el orden previsto y las probabilidades son salidas distintas y pueden señalar favoritos diferentes. El error medio del modelo describe su rendimiento histórico; no es un intervalo de confianza ni una promesa para este GP. Cambiar la salida consulta curvas precalculadas: no vuelve a entrenar el modelo ni simula todos los incidentes de carrera. Puedes guardar variantes en el laboratorio para compararlas.';
      case 'comparar': return '\n\n**Qué indica esta comparación:** el duelo directo usa solo carreras en las que ambos aparecen. Las medias y los puntos de la tabla pueden cubrir muestras distintas: revísalos junto al número de carreras y los abandonos. Estos datos describen el histórico disponible y no determinan por sí solos quién terminará delante en la próxima carrera.';
      case 'piloto': return '\n\n**Lectura de los datos:** la media de llegada resume todas las carreras registradas para este piloto; las últimas cinco muestran una ventana más reciente. Diferencias entre ambas pueden reflejar forma, circuitos o abandonos. No equivalen a estadísticas de toda su carrera deportiva fuera del conjunto de F1 Predictor. Para explorar una carrera concreta, pide el GP y una posición de salida.';
      case 'modelo': return '\n\n**Uso práctico:** compara el error con el baseline y observa cuántas carreras forman el conjunto de prueba. Una AUC alta distingue casos positivos y negativos, pero no demuestra por sí sola que cada porcentaje esté bien calibrado. Usa las probabilidades como estimaciones y contrástalas con las limitaciones explicadas en El modelo.';
      case 'circuito': return '\n\n**Límites del histórico:** una media de pocas ediciones puede cambiar mucho con un solo abandono. Las posiciones ganadas o perdidas incluyen lo ocurrido durante la carrera y no miden directamente el número de adelantamientos. Usa esta tabla como contexto y compárala con la predicción del GP si está disponible.';
      case 'campeonato': return '\n\n**Dónde contrastarlo:** la tabla resume la clasificación incluida en los datos cargados. La sección Campeonato también consulta su fuente en vivo cuando está disponible. Diferencia los puntos oficiales del mundial de los puntos del juego de quiniela: se calculan con reglas diferentes.';
      case 'carrera_pasada': return '\n\n**Qué estás viendo:** son resultados históricos, no una nueva predicción para esa carrera. La variación de puestos compara salida y llegada; un abandono puede alterar esa lectura. En Carreras puedes consultar el resultado completo y contrastarlo con lo que había previsto el modelo.';
      default:return '';
    }
  },
};
