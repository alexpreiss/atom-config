# Elm-Format for Atom

This [Atom Package](https://atom.io/packages/elm-format) automatically formats
your Elm code using [elm-format](https://github.com/avh4/elm-format).

## Usage

When you save an Elm file, it is automatically formatted before it is saved.

You can also trigger formatting without saving first, using:

```
elm-format:file
```

In case of syntax errors you will receive a notification:

![Syntax Error Notification][syntax-error]

atom-elm-format will automatically jump to the first syntax error -
this can be disabled through the package's settings.

You can also jump to the most recent error using:

```
elm-format:jump-to-syntax-error
```

## Sponsor

This open-source project is sponsored by [Humio](https://humio.com/).
Humio is a Real-time, TB scale, distributed, log management platform for cloud
and on-premise deployment.

![Humio][humio-logo]

Humio's frontend is written in Elm and we
love to pay it forward - so others can discover [Elm](http://elm-lang.org/).

[syntax-error]: https://raw.githubusercontent.com/humio/atom-elm-format/master/syntax-error.png "Example of Syntax Error Notification"
[humio-logo]: https://raw.githubusercontent.com/humio/graphics/master/256_big_bird.png "Humio"
