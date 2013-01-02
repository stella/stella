Raphael.fn.pieChart = function (cx, cy, r, values, labels, stroke) {
    var paper = this,
        rad = Math.PI / 180,
        chart = this.set();
    function sector(cx, cy, r, startAngle, endAngle, params) {
        var x1 = cx + r * Math.cos(-startAngle * rad),
            x2 = cx + r * Math.cos(-endAngle * rad),
            y1 = cy + r * Math.sin(-startAngle * rad),
            y2 = cy + r * Math.sin(-endAngle * rad);
        return paper.path(["M", cx, cy, "L", x1, y1, "A", r, r, 0, +(endAngle - startAngle > 180), 0, x2, y2, "z"]).attr(params);
    }
    var angle = 0,
        total = 0,
        start = 0,
        process = function (j) {
            var value = values[j],
                angleplus = 360 * value / total,
                popangle = angle + (angleplus / 2),
                color = "hsb(" + start + ", 1, .5)",
                ms = 500,
                delta = 30,
                bcolor = "hsb(18, 1, 1)",
                p = sector(cx, cy, r, angle, angle + angleplus, {fill: "#33cccc", stroke: stroke, "stroke-width": 2}),
                txt = paper.text(cx + (r + delta + 55) * Math.cos(-popangle * rad), cy + (r + delta + 25) * Math.sin(-popangle * rad), labels[j]).attr({fill: bcolor, stroke: "none", opacity: 0, "font-family": 'Fontin-Sans, Arial', "font-size": "20px"});
            p.mouseover(function () {
                p.animate({scale: [1.1, 1.1, cx, cy]}, ms, "elastic");
                txt.animate({opacity: 1}, ms, "elastic");
            }).mouseout(function () {
                p.animate({scale: [1, 1, cx, cy]}, ms, "elastic");
                txt.animate({opacity: 0}, ms);
            });
            angle += angleplus;
            chart.push(p);
            chart.push(txt);
            start += .1;
        };
    for (var i = 0, ii = values.length; i < ii; i++) {
        total += values[i];
    }
    for (var i = 0; i < ii; i++) {
        process(i);
    }
    return chart;
};

(function (raphael) {
    $(function () {
        var values = [],
            labels = [];
        $(".status tr").each(function () {
            values.push(parseInt($("td", this).text(), 10));
            labels.push($("th", this).text());
        });
        $(".status table").hide();
        raphael("statusGraph", 110, 110).pieChart(-50, 55, 50, values, labels, "#fff");
        //raphael("statusGraph", 110, 110).pieChart(55, 55, 50, values, labels, "#fff");
				//.animate({rotation: "-90 55 55"}, 0) // rotation needs work
    });
})(Raphael.ninja());
