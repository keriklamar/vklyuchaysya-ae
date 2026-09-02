// ============================================================
// dump_layer_geometry.jsx
// Запускать в AE через File → Scripts → Run Script File...
// когда открыта композиция с графикой (после "Edit in After Effects"
// из Premiere).
//
// Автоматически проходит по всем слоям активной композиции и
// выгружает точную геометрию каждого — Position, Anchor Point,
// и bounding box (через sourceRectAtTime, который работает
// одинаково что для текста, что для шейпов, что для солидов).
//
// Результат: layer_geometry.json рядом со скриптом.
// Пришли этот файл — по нему я построю точную раскладку без единой
// догадки.
// ============================================================

function dumpComp(comp) {
    var result = [];
    for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        var entry = {
            index: i,
            name: layer.name,
            enabled: layer.enabled
        };

        try {
            entry.position = layer.property("Position").value;
        } catch (e) { entry.position = null; }

        try {
            entry.anchorPoint = layer.property("Anchor Point").value;
        } catch (e) { entry.anchorPoint = null; }

        try {
            entry.scale = layer.property("Scale").value;
        } catch (e) { entry.scale = null; }

        try {
            var rect = layer.sourceRectAtTime(comp.time, false);
            entry.sourceRect = {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height
            };
            // Абсолютные экранные координаты bounding box'а
            // (с учётом Position, без учёта Anchor Point смещения —
            // грубая, но полезная оценка)
            if (entry.position) {
                entry.absoluteBounds = {
                    left: entry.position[0] + rect.left,
                    top: entry.position[1] + rect.top,
                    right: entry.position[0] + rect.left + rect.width,
                    bottom: entry.position[1] + rect.top + rect.height
                };
            }
        } catch (e) {
            entry.sourceRect = null;
        }

        if (layer instanceof TextLayer) {
            try {
                entry.text = layer.property("Source Text").value.text;
            } catch (e) {}
        }

        result.push(entry);
    }
    return result;
}

function main() {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
        alert("Открой нужную композицию (сделай её активной), потом запусти скрипт ещё раз.");
        return;
    }

    var data = {
        compName: comp.name,
        width: comp.width,
        height: comp.height,
        layers: dumpComp(comp)
    };

    var scriptFile = new File($.fileName);
    var outFile = new File(scriptFile.parent.fsName + "/layer_geometry.json");
    outFile.open("w");
    outFile.write(JSON.stringify(data, null, 2));
    outFile.close();

    alert("Готово! Сохранено: " + outFile.fsName + "\nПришли этот файл в чат.");
}

main();
