/* global CSInterface, JSZip, require */

var csInterface = new CSInterface();

// ------------------------------------------------------------
// НАСТРОЙКИ — если поменяются коды городов / порядок / имена
// композиций в AE-проекте, править нужно только здесь.
// ------------------------------------------------------------
var CITIES = [
  { name: "Минск",   station: 26850 },
  { name: "Брест",   station: 33008 },
  { name: "Витебск", station: 26666 },
  { name: "Гомель",  station: 33041 },
  { name: "Гродно",  station: 26820 },
  { name: "Могилев", station: 26862 }
];

var CURRENCIES = [
  { code: "USD", label: "Доллар США" },
  { code: "EUR", label: "Евро" },
  { code: "RUB", label: "Российский рубль" }
];

var WIND_STORM_THRESHOLD_MS = 20; // м/с — выше этого считаем "ураган/сильный ветер"

var MONTHS_RU_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
var WEEKDAYS_RU_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

// День выпуска: 0 = сегодня, до BROADCAST_DAYS_AHEAD вперёд. Один общий
// селектор в панели — влияет и на погоду (прогноз на этот день), и на
// блок даты на экране.
var BROADCAST_DAYS_AHEAD = 7;
var selectedDayOffset = 0;

function dateShifted(offsetDays) {
  var d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return d;
}

function getLocalDateInfoShort(offsetDays) {
  var d = dateShifted(offsetDays);
  return {
    weekday: WEEKDAYS_RU_SHORT[d.getDay()],
    day: d.getDate(),
    month: MONTHS_RU_SHORT[d.getMonth()]
  };
}

// [{offset, label}] на сегодня + BROADCAST_DAYS_AHEAD дней.
function getBroadcastDays() {
  var out = [];
  for (var i = 0; i <= BROADCAST_DAYS_AHEAD; i++) {
    var d = dateShifted(i);
    var human = WEEKDAYS_RU_SHORT[d.getDay()] + " " + d.getDate() + " " + MONTHS_RU_SHORT[d.getMonth()];
    var prefix = i === 0 ? "Сегодня · " : (i === 1 ? "Завтра · " : "");
    out.push({ offset: i, label: prefix + human });
  }
  return out;
}

// ------------------------------------------------------------
// Маппинг на семантический ключ иконки-анимации (2026-08-25, версия 2).
// Раньше брали текст только из fact.code.CutTypeW (weather-fact) — это
// поле пустое (null) в подавляющем большинстве случаев, оно заполняется
// только под явные опасные явления (гроза/ливень/снег и т.п.), а не под
// обычную облачность ("Малооблачно" и т.д.) — из-за этого везде
// показывало "ясно". Нашли настоящий источник — pogoda.by сам берёт
// текст ("Малооблачно", "Облачно" и т.д.) из ДРУГОГО эндпоинта,
// numeric-weather (см. fetchNumericWeatherForCity ниже), поле
// TypeWeather — используем его как основной источник текста, плюс явные
// флаги GROZA/GOLOLED/TUMAN оттуда же (надёжнее, чем парсить текст).
// Ключи соответствуют WEATHER_ICON_COMP_NAMES в host.jsx (там же —
// реальные имена compов анимаций из Animation/Weather Icons CC2014.aep,
// согласовано с пользователем). Порядок проверок важен: сначала самое
// специфичное (гроза/град/шторм, метель/мокрый снег, ливень/морось),
// иначе более общая проверка (напр. "Дожд") перехватит раньше нужной
// ветки.
// ------------------------------------------------------------
function mapWeatherToIcon(fact, numericRec) {
  var cut = (numericRec && numericRec.TypeWeather) || (fact.code && fact.code.CutTypeW) || "";

  // Явные флаги из numeric-weather — надёжнее текста, проверяем первыми.
  if (numericRec) {
    if (numericRec.GROZA) return "storm";
    if (numericRec.GOLOLED) return "cloudy"; // отдельной иконки гололедицы нет
  }

  if (cut.indexOf("Гроза") !== -1) return "storm";
  if (cut.indexOf("Град") !== -1) return "storm";
  if (cut.indexOf("Штормов") !== -1 || cut.indexOf("ураган") !== -1) return "storm";

  if (cut.indexOf("Метель") !== -1) return "snowy";
  if (cut.indexOf("Мокрый снег") !== -1 || cut.indexOf("снег с дожд") !== -1) return "snowy";
  if (cut.indexOf("Снег") !== -1) return "snowy";

  if (cut.indexOf("Морось") !== -1) return "drizzle";
  if (cut.indexOf("Ливень") !== -1 || cut.indexOf("сильный дожд") !== -1) return "rain";
  if (cut.indexOf("Кратковременный дожд") !== -1 || cut.indexOf("местами дожд") !== -1) return "rain_sunny";
  if (cut.indexOf("Дожд") !== -1) return "rain";
  // Прогнозные формулировки numeric-weather: "Временами осадки",
  // "Продолжительные осадки", "Кратковременные осадки" (снег отсеян выше).
  if (cut.indexOf("Кратковременные осадки") !== -1) return "rain_sunny";
  if (cut.indexOf("осадки") !== -1 || cut.indexOf("Осадки") !== -1) return "rain";

  if (cut.indexOf("Шквалист") !== -1) return "windy";

  if (cut.indexOf("Малооблачно") !== -1) return "partly_sunny";
  if (cut.indexOf("Переменная облачность") !== -1) return "partly_cloudy";
  if (cut.indexOf("прояснени") !== -1) return "partly_cloudy";
  if (cut.indexOf("Значительная облачность") !== -1) return "cloudy";
  if (cut.indexOf("Пасмурно") !== -1) return "cloudy";
  if (cut.indexOf("Облачно") !== -1) return "cloudy";
  if (cut.indexOf("Ясно") !== -1) return "sunny";

  if ((numericRec && numericRec.TUMAN) || cut.indexOf("Туман") !== -1) return "cloudy"; // отдельной иконки тумана нет

  if (fact.speedWindMax && fact.speedWindMax >= WIND_STORM_THRESHOLD_MS) return "windy";
  if (numericRec && numericRec.WINDSP_MAX >= WIND_STORM_THRESHOLD_MS) return "windy";

  return "sunny"; // ничего не распознано — считаем ясно (дневной вариант)
}

function formatTemp(t) {
  var rounded = Math.round(t);
  return (rounded >= 0 ? "+" : "") + rounded + "°";
}

// ------------------------------------------------------------
// Запрос погоды через Node.js https (без CORS-ограничений)
// ------------------------------------------------------------
function fetchWeatherForCity(city) {
  return new Promise(function (resolve, reject) {
    var https = require("https");
    var url = "https://pogoda.by/api/v2/weather-fact?station=" + city.station;

    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "*/*"
      },
      // Локальный антивирус/сетевой фильтр подменяет HTTPS-сертификат
      // (перехват для проверки трафика) — Node из-за этого не доверяет
      // цепочке. Отключаем строгую проверку именно для этого запроса.
      rejectUnauthorized: false
    }, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try {
          var json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error("Не удалось распарсить ответ для " + city.name));
        }
      });
    }).on("error", function (err) {
      reject(err);
    });
  });
}

// ------------------------------------------------------------
// numeric-weather — второй эндпоинт pogoda.by (тот же id города/станции,
// что и в weather-fact — проверено вручную для всех 6 городов). Отдаёт
// почасовой/12-часовой прогноз с полем TypeWeather ("Малооблачно",
// "Облачно" и т.п.) и явными флагами GROZA/GOLOLED/TUMAN — именно
// отсюда берём текст для mapWeatherToIcon (см. выше), а НЕ из
// weather-fact (там это поле почти всегда пустое).
// ------------------------------------------------------------
function fetchNumericWeatherForCity(city) {
  return new Promise(function (resolve, reject) {
    var https = require("https");
    var url = "https://pogoda.by/api/v2/numeric-weather/12/" + city.station;

    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "*/*"
      },
      rejectUnauthorized: false // см. комментарий в fetchWeatherForCity
    }, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Не удалось распарсить numeric-weather для " + city.name));
        }
      });
    }).on("error", function (err) {
      reject(err);
    });
  });
}

// Ответ numeric-weather — объект { "дата-строка": { "0": {...}, "12": {...}, ... } }
// (ключ второго уровня — ADVANCE_TIME, смещение в часах от сегодня 00:00).
function extractCurrentNumericRecord(numericData) {
  var dateKeys = Object.keys(numericData || {});
  if (!dateKeys.length) return null;
  var firstDay = numericData[dateKeys[0]];
  var hourKeys = Object.keys(firstDay || {});
  if (!hourKeys.length) return null;
  return firstDay["0"] || firstDay[hourKeys[0]];
}

// ------------------------------------------------------------
// ПРОГНОЗ НА ВЫБРАННЫЙ ДЕНЬ (дневной срок, 12:00)
// ------------------------------------------------------------
// pogoda.by/weather/synoptic использует публичный numeric-weather/12 —
// это и есть числовой прогноз, что показывает раздел «Синоптик» (диапазон
// синоптик чуть сужает вручную, но средняя ≈ TMP). Открытый эндпоинт даёт
// ~6 дней вперёд; для дней за пределами — прочерк.
function fetchNumericWeather12(station) {
  return new Promise(function (resolve, reject) {
    var https = require("https");
    var url = "https://pogoda.by/api/v2/numeric-weather/12/" + station;
    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "*/*"
      },
      rejectUnauthorized: false // см. комментарий в fetchWeatherForCity
    }, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Не удалось распарсить прогноз для станции " + station)); }
      });
    }).on("error", function (err) { reject(err); });
  });
}

// Запись дневного срока (12:00) для дня dayOffset (0 = сегодня) или null.
function extractDayRecord(numericJson, dayOffset) {
  var dateKeys = Object.keys(numericJson || {});
  if (!dateKeys.length) return null;
  var byOffset = numericJson[dateKeys[0]] || {};
  var wantAdvance = 24 * dayOffset + 12;
  if (byOffset[String(wantAdvance)]) return byOffset[String(wantAdvance)];
  var keys = Object.keys(byOffset);
  for (var i = 0; i < keys.length; i++) {
    var r = byOffset[keys[i]];
    if (r && Number(r.ADVANCE_TIME) === wantAdvance) return r;
  }
  return null;
}

async function fetchAllWeatherForDay(dayOffset) {
  var results = [];
  var missing = 0;
  for (var i = 0; i < CITIES.length; i++) {
    var city = CITIES[i];
    var rec = null;
    try {
      rec = extractDayRecord(await fetchNumericWeather12(city.station), dayOffset);
    } catch (e) { /* город останется без данных */ }
    if (!rec || rec.TMP === undefined || rec.TMP === null) {
      missing++;
      results.push({ city: city.name, temp: "—", icon: "sunny" });
      continue;
    }
    // средняя дневная = (мин+макс)/2 дневного срока (как показывает синоптик:
    // «+21..+23, средняя +22»); если мин/макс нет — TMP (он и так ≈ середина).
    var mid = (typeof rec.TMP_MIN === "number" && typeof rec.TMP_MAX === "number")
      ? (rec.TMP_MIN + rec.TMP_MAX) / 2
      : rec.TMP;
    results.push({
      city: city.name,
      temp: formatTemp(mid),
      icon: mapWeatherToIcon({}, rec) // иконка — из rec.TypeWeather
    });
  }
  if (missing === CITIES.length) {
    throw new Error("Прогноз на этот день недоступен (открытый API pogoda.by даёт ~6 дней вперёд). Выбери день ближе.");
  }
  return results;
}

// ------------------------------------------------------------
// Курс валют (nbrb.by) — 2026-09: два исправления.
//
// 1) Дата — берётся выбранный день выпуска (selectedDayOffset), как у
//    погоды/даты/именин, через ?ondate=YYYY-MM-DD (раньше всегда шёл
//    ?periodicity=0 без даты — т.е. "сегодня", независимо от выбора
//    в "День выпуска"). НБ РБ не публикует курс на каждую дату (будущее
//    ещё не объявлено, дата в прошлом может не попасть на публикацию) —
//    если на выбранный день ответ пуст, откатываемся на предыдущие дни
//    (до NBRB_RATE_LOOKBACK_DAYS) — это и есть официальный курс,
//    действующий на выбранный день (курс не публикуют ежедневно, но он
//    остаётся в силе, пока не объявлен новый).
//
// 2) Округление — 2 знака берутся из ТЕКСТА ответа API десятичной
//    арифметикой (roundDecimalString), а не через Number.toFixed():
//    JS-число — двоичная дробь, и на части значений toFixed(2) даёт не
//    тот результат, что показывает сайт (классический пример — 1.005
//    в JS хранится как 1.00499999..., .toFixed(2) вернёт "1.00" вместо
//    верного "1.01"). Работая со строкой цифр из ответа НБ РБ напрямую,
//    получаем ровно то число, что "на сайте", без бинарной погрешности.
// ------------------------------------------------------------
var NBRB_RATE_LOOKBACK_DAYS = 10;

function isoDateStr(d) {
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

function fetchNbrbRatesRawFor(dateISO) {
  return new Promise(function (resolve, reject) {
    var https = require("https");
    var url = "https://api.nbrb.by/exrates/rates?periodicity=0&ondate=" + dateISO;
    https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      rejectUnauthorized: false
    }, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () { resolve(data); });
    }).on("error", function (err) { reject(err); });
  });
}

// Достаёт "Cur_OfficialRate" ровно для одной валюты ИЗ ТЕКСТА ответа
// (не из JSON.parse) — объекты в ответе nbrb.by плоские (без вложенных
// {}), поэтому такой разбор однозначен.
function extractOfficialRateText(rawText, code) {
  var itemRe = new RegExp('\\{[^{}]*"Cur_Abbreviation":"' + code + '"[^{}]*\\}');
  var item = itemRe.exec(rawText);
  if (!item) return null;
  var rateRe = /"Cur_OfficialRate":\s*(-?[0-9]+(?:\.[0-9]+)?)/;
  var rate = rateRe.exec(item[0]);
  return rate ? rate[1] : null;
}

// Округление ДЕСЯТИЧНОЙ СТРОКИ (round half up), без перевода в float.
function roundDecimalString(numStr, decimals) {
  var neg = numStr.charAt(0) === "-";
  if (neg) numStr = numStr.slice(1);
  var parts = numStr.split(".");
  var intPart = parts[0] || "0";
  var fracPart = parts[1] || "";
  while (fracPart.length <= decimals) fracPart += "0";
  var keep = fracPart.slice(0, decimals);
  var nextDigit = fracPart.charCodeAt(decimals) - 48;
  var digits = (intPart + keep).split("").map(function (ch) { return ch.charCodeAt(0) - 48; });
  if (nextDigit >= 5) {
    var i = digits.length - 1;
    while (i >= 0) {
      digits[i]++;
      if (digits[i] === 10) { digits[i] = 0; i--; } else { break; }
    }
    if (i < 0) digits.unshift(1);
  }
  var s = digits.join("");
  var intLen = s.length - decimals;
  var result = s.slice(0, intLen) + (decimals ? "." + s.slice(intLen) : "");
  return (neg ? "-" : "") + result;
}

function fetchCurrenciesRawForDate(dateObj, triesLeft) {
  return fetchNbrbRatesRawFor(isoDateStr(dateObj)).then(function (rawText) {
    var hasAny = CURRENCIES.some(function (c) { return extractOfficialRateText(rawText, c.code) !== null; });
    if (hasAny || triesLeft <= 0) return rawText;
    var prevDay = new Date(dateObj.getTime());
    prevDay.setDate(prevDay.getDate() - 1);
    return fetchCurrenciesRawForDate(prevDay, triesLeft - 1);
  });
}

function fetchCurrencies() {
  return fetchCurrenciesRawForDate(dateShifted(selectedDayOffset), NBRB_RATE_LOOKBACK_DAYS).then(function (rawText) {
    return CURRENCIES.map(function (c) {
      var raw = extractOfficialRateText(rawText, c.code);
      return { code: c.code, label: c.label, rate: raw ? roundDecimalString(raw, 2) : "" };
    });
  });
}

// ------------------------------------------------------------
// Парсинг .docx: один пункт = один непустой абзац, до 10 штук.
// Общий парсер и для новостей, и для именин — файлы устроены
// одинаково (др_черновик.docx / новости_черновик.docx).
// ------------------------------------------------------------
function readFileAsArrayBuffer(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function parseDocxParagraphs(file, maxItems) {
  var limit = maxItems || 10; // по умолчанию 10 (новости/именины), гороскоп передаёт 12
  var buffer = await readFileAsArrayBuffer(file);
  var zip = await JSZip.loadAsync(buffer);
  var xml = await zip.file("word/document.xml").async("string");

  var paraMatches = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  var items = [];

  for (var i = 0; i < paraMatches.length && items.length < limit; i++) {
    var para = paraMatches[i];
    var textPieces = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    var text = textPieces
      .map(function (t) { return t.replace(/<[^>]+>/g, ""); })
      .join("")
      .trim();
    if (text) items.push(text);
  }
  return items;
}

// ------------------------------------------------------------
// Вызов ExtendScript
// ------------------------------------------------------------
function escapeForEvalScript(jsonStr) {
  return jsonStr.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\r\n]/g, " ");
}

function callHost(functionName, jsonArg) {
  return new Promise(function (resolve) {
    var escaped = escapeForEvalScript(JSON.stringify(jsonArg));
    var script = functionName + "('" + escaped + "')";
    csInterface.evalScript(script, function (result) {
      resolve(result);
    });
  });
}

// ------------------------------------------------------------
// Редактируемые превью-списки — общий helper. Каждый элемент
// массива рисуется как строка полей (input/textarea), значения
// читаются обратно перед отправкой в host.jsx — так пользователь
// видит и может поправить КАЖДЫЙ пункт до того, как он уйдёт в AE.
// ------------------------------------------------------------
function renderEditableRows(container, rows, fields) {
  container.innerHTML = "";
  rows.forEach(function (row) {
    var rowEl = document.createElement("div");
    rowEl.className = "edit-row";
    fields.forEach(function (f) {
      var val = row[f.key] != null ? row[f.key] : (f.button ? (f.cycle && f.cycle[0]) || "" : "");
      if (f.readonly) {
        var span = document.createElement("span");
        span.className = "edit-label";
        span.dataset.key = f.key;
        span.dataset.value = val;
        span.textContent = val;
        rowEl.appendChild(span);
        return;
      }
      if (f.select) {
        // Выпадающий список (напр. иконка погоды) — значение читается
        // как обычное поле (el.value), readEditableRows ничего доп. не
        // требует.
        var select = document.createElement("select");
        select.className = "edit-field";
        select.dataset.key = f.key;
        (f.options || []).forEach(function (opt) {
          var optionEl = document.createElement("option");
          optionEl.value = opt.value;
          optionEl.textContent = opt.label;
          if (opt.value === val) optionEl.selected = true;
          select.appendChild(optionEl);
        });
        rowEl.appendChild(select);
        return;
      }
      if (f.button) {
        // Маленькая кнопка-переключатель (напр. режим 1/2 строки) — по
        // клику циклически меняет значение по списку f.cycle, само
        // значение хранится в dataset.value (как у readonly-полей).
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "edit-toggle-btn";
        btn.dataset.key = f.key;
        btn.dataset.value = val;
        btn.textContent = (f.labels && f.labels[val]) || val;
        btn.addEventListener("click", function () {
          var cycle = f.cycle || [];
          var idx = cycle.indexOf(btn.dataset.value);
          var next = cycle[(idx + 1) % cycle.length];
          btn.dataset.value = next;
          btn.textContent = (f.labels && f.labels[next]) || next;
        });
        rowEl.appendChild(btn);
        return;
      }
      var input = document.createElement(f.textarea ? "textarea" : "input");
      if (!f.textarea) input.type = f.hidden ? "hidden" : "text";
      input.className = "edit-field";
      input.dataset.key = f.key;
      input.value = val;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.width) input.style.width = f.width;
      rowEl.appendChild(input);
    });
    container.appendChild(rowEl);
  });
}

function readEditableRows(container, fields) {
  var rowEls = container.querySelectorAll(".edit-row");
  var rows = [];
  rowEls.forEach(function (rowEl) {
    var row = {};
    fields.forEach(function (f) {
      var el = rowEl.querySelector('[data-key="' + f.key + '"]');
      row[f.key] = el ? ((f.readonly || f.button) ? el.dataset.value : el.value) : "";
    });
    rows.push(row);
  });
  return rows;
}

// Статус — маленькая иконка (✓/!) вместо строки текста (2026-08-25):
// полный текст живёт в title (тултип при наведении) и копируется по
// клику — сама строка нигде не отображается как текст.
function copyToClipboard(text) {
  // Classic execCommand-приём, а не navigator.clipboard — буфер обмена
  // через Clipboard API требует "secure context" (https/localhost),
  // а панель открывается по file:// — там его может не быть.
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch (e) {
    return false;
  }
}

function setStatus(elId, text, isError) {
  var el = document.getElementById(elId);
  el.textContent = isError ? "!" : "✓";
  el.title = text;
  el.dataset.fullText = text;
  el.className = "status-icon" + (isError ? " error" : " ok");
}

// callHost() никогда не реджектит промис на ошибку из host.jsx — evalScript
// всегда резолвит колбэк, даже если ExtendScript-функция вернула
// "ERROR: ...". Раньше это шло прямиком в setStatus(..., "Готово: "+result)
// без проверки — красная иконка не загоралась, хотя в тексте была ошибка.
// Единая точка: сюда отдаём "сырой" result от callHost, сама решает ✓/!.
function showResult(elId, result) {
  var text = String(result);
  var isErr = text.indexOf("ERROR") === 0;
  setStatus(elId, (isErr ? "Ошибка: " : "Готово: ") + text, isErr);
}

// Один обработчик клика на все иконки-статусы сразу (делегирование) —
// копирует в буфер полный текст последнего результата этого блока.
document.addEventListener("click", function (e) {
  var el = e.target.closest ? e.target.closest(".status-icon") : null;
  if (!el || !el.dataset.fullText) return;
  copyToClipboard(el.dataset.fullText);
});

// ------------------------------------------------------------
// Общая обвязка для "кнопка сама фетчит данные и сразу применяет
// их в AE" (погода / курс валют / дата) + отдельная маленькая
// кнопка "Применить правки" — переотправляет то, что сейчас стоит
// в полях превью, БЕЗ повторного запроса, на случай если данные
// поправили вручную уже после автозагрузки.
// ------------------------------------------------------------
function wireFetchApplySection(opts) {
  var btn = document.getElementById(opts.btnId);
  var applyBtn = opts.applyEditsBtnId ? document.getElementById(opts.applyEditsBtnId) : null;
  var previewEl = document.getElementById(opts.previewId);

  function toHostArgs(rows) {
    return opts.toHostArgs ? opts.toHostArgs(rows) : rows;
  }

  btn.addEventListener("click", async function () {
    setStatus(opts.statusId, "Загружаю...");
    try {
      var rows = await opts.fetchFn();
      renderEditableRows(previewEl, rows, opts.fields);
      var result = await callHost(opts.hostFn, toHostArgs(rows));
      showResult(opts.statusId, result);
    } catch (e) {
      setStatus(opts.statusId, "Ошибка: " + e.message, true);
    }
  });

  if (applyBtn) {
    applyBtn.addEventListener("click", async function () {
      var rows = readEditableRows(previewEl, opts.fields);
      if (!rows.length) { setStatus(opts.statusId, "Сначала нажми основную кнопку выше — нечего применять.", true); return; }
      setStatus(opts.statusId, "Применяю правки...");
      try {
        var result = await callHost(opts.hostFn, toHostArgs(rows));
        showResult(opts.statusId, result);
      } catch (e) {
        setStatus(opts.statusId, "Ошибка: " + e.message, true);
      }
    });
  }
}

// ------------------------------------------------------------
// Погода
// ------------------------------------------------------------
// Короткие человеческие подписи для 10 состояний иконки-анимации (ключи
// см. WEATHER_ICON_COMP_NAMES в host.jsx) — чтобы можно было руками
// поправить погоду/иконку прямо в панели, если авто-определение
// ошиблось.
var WEATHER_ICON_OPTIONS = [
  { value: "sunny", label: "Ясно" },
  { value: "partly_sunny", label: "Малооблачно" },
  { value: "partly_cloudy", label: "Переменная обл." },
  { value: "cloudy", label: "Облачно" },
  { value: "drizzle", label: "Морось" },
  { value: "rain", label: "Дождь" },
  { value: "rain_sunny", label: "Кратк. дождь" },
  { value: "snowy", label: "Снег" },
  { value: "storm", label: "Гроза" },
  { value: "windy", label: "Ветер" }
];

var WEATHER_FIELDS = [
  { key: "city", placeholder: "Город" },
  { key: "temp", placeholder: "Темп.", width: "70px" },
  { key: "icon", select: true, options: WEATHER_ICON_OPTIONS }
];
wireFetchApplySection({
  btnId: "btnWeather",
  applyEditsBtnId: "btnWeatherApplyEdits",
  statusId: "weatherStatus",
  previewId: "weatherPreview",
  fields: WEATHER_FIELDS,
  fetchFn: function () { return fetchAllWeatherForDay(selectedDayOffset); },
  hostFn: "buildWeatherCycleTimeline"
});

// ------------------------------------------------------------
// Курс валют
// ------------------------------------------------------------
var CURRENCY_FIELDS = [
  { key: "code", hidden: true },
  { key: "label", readonly: true },
  { key: "rate", placeholder: "Курс", width: "80px" }
];
wireFetchApplySection({
  btnId: "btnCurrency",
  applyEditsBtnId: "btnCurrencyApplyEdits",
  statusId: "currencyStatus",
  previewId: "currencyPreview",
  fields: CURRENCY_FIELDS,
  fetchFn: fetchCurrencies,
  hostFn: "applyCurrencyRates"
});

// ------------------------------------------------------------
// Дата / день недели — значение подтягивается локально (без сети)
// автоматически при открытии панели, отправка в AE — по кнопке.
// ------------------------------------------------------------
var DATE_FIELDS = [
  { key: "weekday", placeholder: "День недели", width: "70px" },
  { key: "day", placeholder: "Число", width: "50px" },
  { key: "month", placeholder: "Месяц", width: "70px" }
];
wireFetchApplySection({
  btnId: "btnDate",
  applyEditsBtnId: "btnDateApplyEdits",
  statusId: "dateStatus",
  previewId: "datePreview",
  fields: DATE_FIELDS,
  fetchFn: function () { return Promise.resolve([getLocalDateInfoShort(selectedDayOffset)]); },
  hostFn: "applyDateInfo",
  toHostArgs: function (rows) { return rows[0] || {}; } // host ждёт один объект, не массив
});

function refreshDatePreview() {
  renderEditableRows(document.getElementById("datePreview"), [getLocalDateInfoShort(selectedDayOffset)], DATE_FIELDS);
}
// Заполняем превью сразу при открытии панели — не дожидаясь клика,
// в AE при этом ничего не отправляем (для этого нужна кнопка).
refreshDatePreview();

// Селектор дня выпуска — один на всё: меняет и погоду (по кнопке «Обновить
// погоду»), и превью даты (сразу).
(function initBroadcastDaySelector() {
  var sel = document.getElementById("broadcastDay");
  if (!sel) return;
  var days = getBroadcastDays();
  for (var i = 0; i < days.length; i++) {
    var opt = document.createElement("option");
    opt.value = String(days[i].offset);
    opt.textContent = days[i].label;
    sel.appendChild(opt);
  }
  sel.value = "0";
  sel.addEventListener("change", function () {
    selectedDayOffset = parseInt(sel.value, 10) || 0;
    refreshDatePreview();
  });
})();

// ------------------------------------------------------------
// Новости — файл выбирается → сразу парсится и показывается
// редактируемым списком; кнопка "Загрузить новости" отправляет
// то, что сейчас стоит в полях (исходное или уже поправленное).
// ------------------------------------------------------------
var NEWS_FIELDS = [
  { key: "num", readonly: true },
  { key: "text", textarea: true, placeholder: "Текст новости" },
  // Кнопка справа от каждой новости: авто (как решит host.jsx по числу
  // слов) / принудительно 1 строка / принудительно 2 строки. Если в самом
  // тексте руками поставлен перенос строки — он побеждает оба режима.
  { key: "mode", button: true, cycle: ["auto", "1", "2"], labels: { auto: "авто", "1": "1 стр.", "2": "2 стр." } }
];

document.getElementById("docxFile").addEventListener("change", async function (e) {
  var file = e.target.files[0];
  if (!file) return;
  try {
    var items = await parseDocxParagraphs(file, 6); // 6 новостей (было 10)
    renderEditableRows(document.getElementById("newsPreview"), items.map(function (t, i) { return { text: t, num: (i + 1) + "." }; }), NEWS_FIELDS);
    document.getElementById("btnNews").disabled = false;
    setStatus("newsStatus", "Найдено новостей: " + items.length);
  } catch (err) {
    setStatus("newsStatus", "Ошибка чтения docx: " + err.message, true);
  }
});

document.getElementById("btnNews").addEventListener("click", async function () {
  var rows = readEditableRows(document.getElementById("newsPreview"), NEWS_FIELDS);
  if (!rows.length) { setStatus("newsStatus", "Сначала выбери файл новостей.", true); return; }
  setStatus("newsStatus", "Загружаю в проект...");
  try {
    var result = await callHost("applyNewsItems", rows.map(function (r) { return { text: r.text, mode: r.mode || "auto" }; }));
    showResult("newsStatus", result);
  } catch (e) {
    setStatus("newsStatus", "Ошибка: " + e.message, true);
  }
});

// ------------------------------------------------------------
// Именины — одна строка, имена через запятую (2026-08-25). Правило
// количества строк на плашке — считает host.jsx: 1-4 имени -> 1 строка,
// 5-8 -> 2 строки. Перенос строки (Enter), если пользователь поставил
// его сам в этом поле — явно указывает, где кончается 1-я строка и
// начинается 2-я (побеждает авто-правило 1-4/5-8 целиком) — тот же
// принцип, что и в новостях/гороскопе. Поэтому отправляем RAW-текст поля
// как есть (host.jsx сам решает, резать по \n или считать имена по
// запятым) — никакого предварительного разбора на массив имён тут.
//
// Автоматический источник имён: kalendarik.com.ua/kalendar-imenin сам
// берёт данные из ПУБЛИЧНОГО Google-календаря через встроенный виджет
// fullCalendar (нашли, посмотрев исходный код их страницы). Первая
// попытка — дёрнуть Google Calendar API прямо отсюда (fetch с подделанным
// Referer) — не сработала (403: CEF режет referrer-override для
// чужого origin). Поэтому сам запрос теперь делает host.jsx через
// system.callSystem()+curl.exe (обычный процесс ОС, никаких
// browser-ограничений) — тут только просим его и разбираем результат.

// Простой случайный выбор N элементов без повторов.
function pickRandom(arr, n) {
  var copy = arr.slice();
  var picked = [];
  while (copy.length && picked.length < n) {
    var idx = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(idx, 1)[0]);
  }
  return picked;
}

// yyyy-mm-dd выбранного дня выпуска.
function selectedDateISO() {
  var d = dateShifted(selectedDayOffset);
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

document.getElementById("btnBdayFetch").addEventListener("click", async function () {
  var iso = selectedDateISO();
  setStatus("bdayStatus", "Загружаю имена на " + iso + "...");
  try {
    var raw = await callHost("fetchNamedaysToday", { dateISO: iso });
    if (raw.indexOf("ERROR") === 0) { setStatus("bdayStatus", raw, true); return; }
    var all = JSON.parse(raw);
    if (!all.length) { setStatus("bdayStatus", "Имён на " + iso + " не найдено (пустой ответ).", true); return; }
    var picked = pickRandom(all, 8);
    document.getElementById("bdayNamesInput").value = picked.join(", ");
    setStatus("bdayStatus", "Найдено " + all.length + " имён на " + iso + ", выбрано случайных 8 — можно поправить перед загрузкой.");
  } catch (e) {
    setStatus("bdayStatus", "Ошибка получения имён: " + e.message, true);
  }
});

document.getElementById("btnBirthday").addEventListener("click", async function () {
  var raw = document.getElementById("bdayNamesInput").value || "";
  if (!raw.trim()) { setStatus("bdayStatus", "Сначала впиши имена через запятую.", true); return; }
  setStatus("bdayStatus", "Загружаю в проект...");
  try {
    var result = await callHost("applyBirthdayNames", raw);
    showResult("bdayStatus", result);
  } catch (e) {
    setStatus("bdayStatus", "Ошибка: " + e.message, true);
  }
});

// ------------------------------------------------------------
// Гороскоп — тот же паттерн, что новости/именины: файл выбирается →
// сразу парсится и показывается редактируемым списком; кнопка
// "Загрузить гороскоп" отправляет то, что сейчас стоит в полях.
// ------------------------------------------------------------
var HOROSCOPE_FIELDS = [
  { key: "num", readonly: true },
  { key: "text", textarea: true, placeholder: "Текст гороскопа" },
  { key: "mode", button: true, cycle: ["auto", "1", "2"], labels: { auto: "авто", "1": "1 стр.", "2": "2 стр." } }
];

document.getElementById("horoscopeFile").addEventListener("change", async function (e) {
  var file = e.target.files[0];
  if (!file) return;
  try {
    var items = await parseDocxParagraphs(file, 12);
    renderEditableRows(document.getElementById("horoscopePreview"), items.map(function (t, i) { return { text: t, num: (i + 1) + "." }; }), HOROSCOPE_FIELDS);
    document.getElementById("btnHoroscope").disabled = false;
    setStatus("horoscopeStatus", "Найдено гороскопов: " + items.length);
  } catch (err) {
    setStatus("horoscopeStatus", "Ошибка чтения docx: " + err.message, true);
  }
});

document.getElementById("btnHoroscope").addEventListener("click", async function () {
  var rows = readEditableRows(document.getElementById("horoscopePreview"), HOROSCOPE_FIELDS);
  if (!rows.length) { setStatus("horoscopeStatus", "Сначала выбери файл гороскопа.", true); return; }
  setStatus("horoscopeStatus", "Загружаю в проект...");
  try {
    var result = await callHost("applyHoroscopeItems", rows.map(function (r) { return { text: r.text, mode: r.mode || "auto" }; }));
    showResult("horoscopeStatus", result);
  } catch (e) {
    setStatus("horoscopeStatus", "Ошибка: " + e.message, true);
  }
});

// Одна кнопка на все переходы сразу (2026-08-25, раньше было 2 отдельные
// — "все блоки" и "пункты+валюта"; 2026-08-29 — сюда же добавили погоду,
// отдельную кнопку "Анимация погоды" убрали из панели за ненадобностью).
document.getElementById("btnAllTransitions").addEventListener("click", async function () {
  setStatus("allTransitionsStatus", "Настраиваю переходы...");
  try {
    var results = [];
    var weatherRows = readEditableRows(document.getElementById("weatherPreview"), WEATHER_FIELDS);
    if (weatherRows.length) {
      var weatherResult = await callHost("applyWeatherTransitions", weatherRows);
      results.push("ПОГОДА: " + weatherResult);
    }
    var result = await callHost("applyAllTransitionsCombined", {});
    results.push(result);
    showResult("allTransitionsStatus", results.join(" || "));
  } catch (e) {
    setStatus("allTransitionsStatus", "Ошибка: " + e.message, true);
  }
});

