// ============================================================
// build_shapes_only.jsx
// Строит ТОЛЬКО 4 подложки-прямоугольника, с координатами,
// вычисленными напрямую из layer_geometry.json (position - anchorPoint
// + sourceRect.left/top = реальный экранный прямоугольник).
// Без текста — только геометрия, чтобы сверить с оригиналом.
// ============================================================

var FPS = 50;
var W = 1920, H = 1080;

function removeExistingComp(name) {
    for (var i = app.project.numItems; i >= 1; i--) {
        var item = app.project.item(i);
        if (item instanceof CompItem && item.name === name) item.remove();
    }
}

// Точные абсолютные прямоугольники, вычисленные из
// layer_geometry.json: x = position.x - anchor.x + sourceRect.left,
//                       y = position.y - anchor.y + sourceRect.top
var SHAPES = [
    { name: "bg_city",  x: 380.05, y: 941.55, w: 296.79, h: 90.52, color: [0.98, 0.98, 1.0] },
    { name: "bg_temp",  x: 677.08, y: 941.55, w: 145.66, h: 90.52, color: [0.25, 0.62, 0.93] },
    { name: "bg_deg",   x: 822.33, y: 941.55, w: 91.90,  h: 90.52, color: [0.25, 0.62, 0.93] },
    { name: "bg_news",  x: 916.13, y: 942.19, w: 769.23, h: 89.12, color: [0.90, 0.91, 0.94] }
];

function main() {
    removeExistingComp("SHAPES_TEST");
    var comp = app.project.items.addComp("SHAPES_TEST", W, H, 1, 10, FPS);

    for (var i = 0; i < SHAPES.length; i++) {
        var s = SHAPES[i];
        var w = Math.round(s.w);
        var h = Math.round(s.h);
        var solid = comp.layers.addSolid(s.color, s.name, w, h, 1, 10);
        solid.name = s.name;
        // anchor в центре, position = центр прямоугольника
        solid.property("Anchor Point").setValue([w / 2, h / 2]);
        solid.property("Position").setValue([s.x + w / 2, s.y + h / 2]);
    }

    alert("Готово! Композиция SHAPES_TEST создана — 4 подложки без текста,\n" +
          "координаты взяты напрямую из layer_geometry.json.");
}

main();
