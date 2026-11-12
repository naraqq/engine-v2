// Image imports
declare module '*.webp' {
    const value: string;
    export default value;
}

declare module '*.png' {
    const value: string;
    export default value;
}

declare module '*.jpg' {
    const value: string;
    export default value;
}

declare module '*.jpeg' {
    const value: string;
    export default value;
}

declare module '*.gif' {
    const value: string;
    export default value;
}

declare module '*.svg' {
    const value: string;
    export default value;
}

declare module '*?raw' {
    const value: string;
    export default value;
}

declare module '*.proto?raw' {
    const value: string;
    export default value;
}

// Protobuf/JSON types
type JSONElement = string | number | boolean | null | JSONObject | JSONArray;
type JSONObject<T = JSONElement> = { [key: string]: T };
type JSONArray<T = JSONElement> = T[];
