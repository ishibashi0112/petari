import { useState } from "react";
import { bridge } from "./generated/contract";
import { searchParts } from "./api";

export function App() {
  const [keyword, setKeyword] = useState("");
  return (
    <main>
      <input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      <button onClick={() => searchParts(bridge, keyword)}>検索</button>
    </main>
  );
}
