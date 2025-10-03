//import gulp from "gulp";
var gulp = require("gulp");

//import ts from "gulp-typescript";
var ts = require("gulp-typescript");

var tsProject = ts.createProject("tsconfig.json");

gulp.task("build", function () {
    return tsProject.src()
        .pipe(tsProject())
        .js.pipe(gulp.dest("./dist2"));
});
