import * as m from "mithril";
import { Pipe } from "./pipes";

function createTextInput(textIn: Pipe<string> | string, attributes: Pipe<m.Attributes> | m.Attributes) {

    const textInPipe = Pipe.asPipe(textIn);
    const attributesPipe = Pipe.asPipe(attributes);
    const textUpdates = Pipe.state<string>();
    const textState = Pipe.merge(textInPipe, textUpdates);

    const vnodes = Pipe.combine(textState, attributesPipe)
        .map(([val, attrs]) => render(val, attrs));

    let element: HTMLInputElement | HTMLTextAreaElement;

    function render(value, attrs) {
        const defaultAttrs = {
            oninput: e => textUpdates.set(e.target.value),
            oncreate: e => element = e.dom,
            value: value
        };

        const allAttrs = Object.assign({}, defaultAttrs, attrs);

        return () => m('input.input', allAttrs);
    }

    return {
        vnodes: vnodes,
        textUpdates: <Pipe<string>>textUpdates
    };
}

export default {
    text: createTextInput
};